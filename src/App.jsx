import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";
import { v4 as uuidv4 } from "uuid";
import "./App.css";
import { Send, ImagePlus, Plus, Minus, X, PlusCircle, MinusCircle, Search, Menu, LogOut } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL;

const GUEST_NAMES = [
  "Happy Panda",
  "Sunny Fox",
  "Cool Tiger",
  "Jolly Bear",
  "Magic Bunny",
  "Lucky Duck",
  "Smiley Koala",
  "Friendly Wolf",
];

function App() {
  const socketRef = useRef(null);

  const [activeScreen, setActiveScreen] = useState("home");

  const [userId, setUserId] = useState("");
  const [name, setName] = useState("");

  const [latitude, setLatitude] = useState(0);
  const [longitude, setLongitude] = useState(0);

  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [currentRoomId, setCurrentRoomId] = useState("");

  const [messageText, setMessageText] = useState("");
  const [messages, setMessages] = useState([]);
  const [logs, setLogs] = useState([]);
  const [isImageUploading, setIsImageUploading] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState(0);
  const [maintenanceNotice, setMaintenanceNotice] = useState(null);
  const [matchRadiusMeters, setMatchRadiusMeters] = useState(import.meta.env.MATCH_RADIUS_METERS);

  const lastSentLocationRef = useRef(null);
  const locationWatchIdRef = useRef(null);
  const lastSentAtRef = useRef(0);
  const lastAcceptedLocationRef = useRef(null);
  const pendingLocationRef = useRef(null);
  const trailingLocationTimeoutRef = useRef(null);

  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isLocationAllowed, setIsLocationAllowed] = useState(false);
  const [isWatchingLocation, setIsWatchingLocation] = useState(false);
  const [useMockLocation] = useState(false);
  const [locationPermissionNotice, setLocationPermissionNotice] = useState(null);

  useEffect(() => {
    let isMounted = true;

    const fetchOnlineUsers = async () => {
      try {
        const res = await axios.get(`${API_URL}/stats/online-users`);
        if (isMounted) {
          setOnlineUsers(Number(res.data.onlineUsers || 0));
        }
      } catch (error) {
        console.log(
          "Failed to fetch online users:",
          error.response?.data || error.message
        );
      }
    };

    fetchOnlineUsers();

    const intervalId = setInterval(fetchOnlineUsers, 5000);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!navigator.permissions?.query) return;

    let permissionStatus;

    navigator.permissions
      .query({ name: "geolocation" })
      .then((status) => {
        permissionStatus = status;

        const syncLocationPermission = () => {
          if (status.state === "denied") {
            setIsLocationAllowed(false);
            setLocationPermissionNotice({
              title: "Location permission is blocked",
              message:
                "Your browser is currently blocking location access for this site.",
              steps:
                // <p>To enable it: Click the locked map pin/site or
                <p>To enable it: Click the locked map pin/site{' '}
                  {/* <MapPinOff className="inline-block h-4 w-4 align-text-bottom mx-1"/>{' '} */}
                  settings icon near the browser address bar → Location → Allow → refresh or click Try again.
                </p>
            });
          }

          if (status.state === "granted") {
            setLocationPermissionNotice(null);
          }
        };

        syncLocationPermission();

        status.onchange = syncLocationPermission;
      })
      .catch(() => { });

    return () => {
      if (permissionStatus) {
        permissionStatus.onchange = null;
      }
    };
  }, []);

  const resetLocalSession = () => {
    stopLocationWatcher();

    socketRef.current = null;

    setConnected(false);
    setCurrentRoomId("");
    setMessages([]);
    setMessageText("");
    setToken("");
    setUserId("");
    setName("");
    setLatitude(0);
    setLongitude(0);
    setIsLocationAllowed(false);
    setIsWatchingLocation(false);
    setActiveScreen("home");
  };

  const sendImageMessage = async (file) => {
    if (!file) return;

    if (!currentRoomId) {
      alert("You are not connected to a nearby friend yet.");
      return;
    }

    if (!token) {
      alert("Login token missing. Please reconnect.");
      return;
    }

    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];

    if (!allowedTypes.includes(file.type)) {
      alert("Only JPG, PNG, WEBP and GIF images are allowed.");
      return;
    }

    const maxSizeInBytes = 3 * 1024 * 1024;

    if (file.size > maxSizeInBytes) {
      alert("Image size should be less than 3 MB.");
      return;
    }

    try {
      setIsImageUploading(true);

      const formData = new FormData();
      formData.append("image", file);
      formData.append("clientMessageId", uuidv4());

      const res = await axios.post(`${API_URL}/messages/image`, formData, {

        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      addLog("Image message sent", res.data);
    } catch (error) {
      addLog("Image message failed", error.response?.data || error.message);
      alert(error.response?.data?.message || "Failed to send image.");
      console.log("Error in uploading image:", error)
    } finally {
      setIsImageUploading(false);
    }
  };

  const logout = () => {
    const socket = socketRef.current;

    const finishLogout = () => {
      socket?.disconnect();
      resetLocalSession();
      addLog("Logged out");
    };

    if (!socket || !socket.connected) {
      finishLogout();
      return;
    }

    let completed = false;

    const safeFinish = () => {
      if (completed) return;
      completed = true;
      finishLogout();
    };

    socket.emit(
      "room:leave",
      {
        reason: "logout",
      },
      (ack) => {
        addLog("Logout room leave ack", ack);
        safeFinish();
      }
    );

    // Fallback in case the server does not send ACK.
    setTimeout(safeFinish, 1200);
  };

  const LOCATION_UPDATE_INTERVAL_MS = 2000;
  const MAX_ACCEPTABLE_ACCURACY_METERS = 100;
  const MAX_REASONABLE_SPEED_MPS = 5;
  const IS_LOCATION_OVERRIDE_TESTING = true;
  const MIN_LOCATION_CHANGE_METERS = 5;

  const LOCATION_OPTIONS = {
    enableHighAccuracy: true,
    timeout: 20000,
    maximumAge: 0,
  };

  const displayName = name || "Guest Friend";

  const connectionLabel = useMemo(() => {
    if (!connected) return "Not connected";
    if (currentRoomId) return "Connected nearby";
    return "Searching nearby";
  }, [connected, currentRoomId]);

  const generateGuestUser = () => {
    const randomName =
      GUEST_NAMES[Math.floor(Math.random() * GUEST_NAMES.length)];

    const shortId = uuidv4().slice(0, 8);

    return {
      userId: `guest_${shortId}`,
      name: `${randomName} ${shortId.slice(0, 3)}`,
    };
  };

  const addLog = (msg, data = null) => {
    setLogs((prev) => [
      {
        time: new Date().toLocaleTimeString(),
        msg,
        data,
      },
      ...prev,
    ]);
  };

  const syncRuntimeConfig = async () => {
    try {
      const res = await axios.get(`${API_URL}/app/runtime-config`);

      const config = res.data?.config;

      if (config?.Match_Radius) {
        setMatchRadiusMeters(Number(config.Match_Radius));
      }

      if (config?.isMaintenance) {
        setMaintenanceNotice({
          title: "Website under maintenance",
          message: "Website is under maintenance. Please try again later.",
        });

        setActiveScreen("home");

        if (socketRef.current) {
          socketRef.current.disconnect();
          socketRef.current = null;
        }

        stopLocationWatcher();
        setConnected(false);
        setCurrentRoomId("");
        setMessages([]);
        setMessageText("");

        return;
      }

      setMaintenanceNotice(null);
    } catch (error) {
      console.log(
        "Failed to fetch runtime config:",
        error.response?.data || error.message
      );
    }
  };

  useEffect(() => {
    syncRuntimeConfig();
  }, []);

  function getDistanceInMeters(lat1, lon1, lat2, lon2) {
    const EARTH_RADIUS_METERS = 6371000;
    const toRadians = (degrees) => (degrees * Math.PI) / 180;

    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);

    const rLat1 = toRadians(lat1);
    const rLat2 = toRadians(lat2);

    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rLat1) *
      Math.cos(rLat2) *
      Math.sin(dLon / 2) ** 2;

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return EARTH_RADIUS_METERS * c;
  }

  const getGeoErrorMessage = (error) => {
    if (!error) return "Unable to get location.";

    switch (error.code) {
      case error.PERMISSION_DENIED:
        return "Location permission denied. Please allow location access to continue.";
      case error.POSITION_UNAVAILABLE:
        return "Location information is unavailable.";
      case error.TIMEOUT:
        return "Location request timed out. Please try again.";
      default:
        return "Unable to get location.";
    }
  };

  const showLocationPermissionNotice = (error) => {
    const message = getGeoErrorMessage(error);

    setLocationPermissionNotice({
      title: "Location permission is required",
      message,
      steps:
        "To enable it: Click the locked map pin/ site settings icon near the browser address bar → Location → Allow → refresh or click Try again.",
    });
  };

  const getCurrentLocation = () => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation is not supported by this browser."));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
          });
        },
        (error) => {
          reject(error);
        },
        LOCATION_OPTIONS
      );
    });
  };

  const isLocationSpike = ({ latitude, longitude, accuracy }) => {
    const now = Date.now();

    if (
      typeof accuracy === "number" &&
      accuracy > MAX_ACCEPTABLE_ACCURACY_METERS
    ) {
      return {
        isSpike: true,
        reason: "Poor GPS accuracy",
        accuracy,
      };
    }

    const lastAcceptedLocation = lastAcceptedLocationRef.current;

    if (!lastAcceptedLocation) {
      return {
        isSpike: false,
        reason: "First accepted location",
      };
    }

    const distanceMoved = getDistanceInMeters(
      lastAcceptedLocation.latitude,
      lastAcceptedLocation.longitude,
      latitude,
      longitude
    );

    const timeDiffSeconds = (now - lastAcceptedLocation.timestamp) / 1000;

    if (timeDiffSeconds <= 0) {
      return {
        isSpike: true,
        reason: "Invalid time difference",
      };
    }

    const speedMps = distanceMoved / timeDiffSeconds;

    if (!IS_LOCATION_OVERRIDE_TESTING && speedMps > MAX_REASONABLE_SPEED_MPS) {
      return {
        isSpike: true,
        reason: "Unrealistic movement speed",
        distanceMoved: Number(distanceMoved.toFixed(2)),
        timeDiffSeconds: Number(timeDiffSeconds.toFixed(2)),
        speedMps: Number(speedMps.toFixed(2)),
      };
    }

    return {
      isSpike: false,
      reason: "Location looks valid",
      distanceMoved: Number(distanceMoved.toFixed(2)),
      speedMps: Number(speedMps.toFixed(2)),
    };
  };

  const markLocationAsSent = (location) => {
    lastSentLocationRef.current = {
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
    };

    lastSentAtRef.current = Date.now();
  };

  const sendLocationToServer = (
    lat,
    lng,
    accuracy = null,
    source = "manual"
  ) => {
    if (!socketRef.current || !socketRef.current.connected) {
      addLog("Location update skipped, socket is not connected");
      return false;
    }

    socketRef.current.emit(
      "location:update",
      {
        latitude: Number(lat),
        longitude: Number(lng),
        accuracy: accuracy === null ? null : Number(accuracy),
        sentAt: Date.now(),
      },
      (ack) => {
        addLog(`${source} location update ack`, ack);
      }
    );

    return true;
  };

  const flushPendingLocation = () => {
    const pendingLocation = pendingLocationRef.current;

    if (!pendingLocation) return;

    const lastSentLocation = lastSentLocationRef.current;

    if (lastSentLocation) {
      const distanceMoved = getDistanceInMeters(
        lastSentLocation.latitude,
        lastSentLocation.longitude,
        pendingLocation.latitude,
        pendingLocation.longitude
      );

      if (distanceMoved < MIN_LOCATION_CHANGE_METERS) {
        addLog("Pending location skipped", {
          reason: "User has not moved enough",
          distanceMoved: Number(distanceMoved.toFixed(2)),
          minRequiredMeters: MIN_LOCATION_CHANGE_METERS,
        });

        pendingLocationRef.current = null;
        return;
      }
    }

    const sent = sendLocationToServer(
      pendingLocation.latitude,
      pendingLocation.longitude,
      pendingLocation.accuracy,
      "auto trailing"
    );

    if (sent) {
      markLocationAsSent(pendingLocation);
      pendingLocationRef.current = null;
    }
  };

  const scheduleTrailingLocationUpdate = () => {
    if (trailingLocationTimeoutRef.current !== null) return;

    const now = Date.now();
    const lastSentAt = lastSentAtRef.current;

    const remainingTime = Math.max(
      LOCATION_UPDATE_INTERVAL_MS - (now - lastSentAt),
      0
    );

    trailingLocationTimeoutRef.current = setTimeout(() => {
      trailingLocationTimeoutRef.current = null;
      flushPendingLocation();
    }, remainingTime);
  };

  const stopLocationWatcher = () => {
    if (locationWatchIdRef.current !== null) {
      navigator.geolocation.clearWatch(locationWatchIdRef.current);
      locationWatchIdRef.current = null;
    }

    if (trailingLocationTimeoutRef.current !== null) {
      clearTimeout(trailingLocationTimeoutRef.current);
      trailingLocationTimeoutRef.current = null;
    }

    lastSentLocationRef.current = null;
    lastSentAtRef.current = 0;
    lastAcceptedLocationRef.current = null;
    pendingLocationRef.current = null;

    setIsWatchingLocation(false);
  };

  const startLocationWatcher = (socket) => {
    if (useMockLocation) {
      addLog("Location watcher skipped", "Mock location mode is enabled");
      return;
    }

    if (!navigator.geolocation) {
      addLog("Location watch failed", "Geolocation is not supported.");
      return;
    }

    stopLocationWatcher();

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const newLatitude = position.coords.latitude;
        const newLongitude = position.coords.longitude;
        const accuracy = position.coords.accuracy;

        setLatitude(newLatitude);
        setLongitude(newLongitude);
        setIsLocationAllowed(true);

        const locationCheck = isLocationSpike({
          latitude: newLatitude,
          longitude: newLongitude,
          accuracy,
        });

        if (locationCheck.isSpike) {
          addLog("Location spike rejected", locationCheck);
          return;
        }

        const acceptedLocation = {
          latitude: newLatitude,
          longitude: newLongitude,
          accuracy,
          timestamp: Date.now(),
        };

        lastAcceptedLocationRef.current = acceptedLocation;

        const now = Date.now();
        const lastSentLocation = lastSentLocationRef.current;
        const lastSentAt = lastSentAtRef.current;

        if (!lastSentLocation) {
          const sent = sendLocationToServer(
            acceptedLocation.latitude,
            acceptedLocation.longitude,
            acceptedLocation.accuracy,
            "auto first"
          );

          if (sent) {
            markLocationAsSent(acceptedLocation);
          }

          return;
        }

        const distanceMoved = getDistanceInMeters(
          lastSentLocation.latitude,
          lastSentLocation.longitude,
          acceptedLocation.latitude,
          acceptedLocation.longitude
        );

        if (distanceMoved < MIN_LOCATION_CHANGE_METERS) {
          return;
        }

        const timePassed = now - lastSentAt >= LOCATION_UPDATE_INTERVAL_MS;

        if (!timePassed) {
          pendingLocationRef.current = acceptedLocation;
          scheduleTrailingLocationUpdate();
          return;
        }

        const sent = sendLocationToServer(
          acceptedLocation.latitude,
          acceptedLocation.longitude,
          acceptedLocation.accuracy,
          "auto throttled"
        );

        if (sent) {
          markLocationAsSent(acceptedLocation);
        }
      },
      (error) => {
        const message = getGeoErrorMessage(error);

        addLog("Location watch error", message);

        if (error.code === error.PERMISSION_DENIED) {
          setIsLocationAllowed(false);
          showLocationPermissionNotice(error);
          stopLocationWatcher();
          socket?.disconnect();
          // alert("Location permission is required. You have been disconnected.");
          setActiveScreen("home");
        }
      },
      LOCATION_OPTIONS
    );

    locationWatchIdRef.current = watchId;
    setIsWatchingLocation(true);

    addLog("Started dynamic location tracking", {
      intervalMs: LOCATION_UPDATE_INTERVAL_MS,
      minDistanceMeters: MIN_LOCATION_CHANGE_METERS,
    });
  };

  const loginGuest = async (guestUser) => {
    let location;

    try {
      location = await getCurrentLocation();

      setLatitude(location.latitude);
      setLongitude(location.longitude);
      setIsLocationAllowed(true);
      setLocationPermissionNotice(null);

      addLog("Location permission granted", location);
    }
    catch (error) {
      setIsLocationAllowed(false);

      const message = getGeoErrorMessage(error);
      addLog("Location permission denied", message);

      showLocationPermissionNotice(error);

      return null;
    }
    try {
      const res = await axios.post(`${API_URL}/auth/login`, {
        userId: guestUser.userId,
        name: guestUser.name,
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
      });

      setToken(res.data.token);
      addLog("Guest login successful", res.data);

      return res.data.token;
    } catch (error) {
      const responseData = error.response?.data;

      addLog("Guest login failed", responseData || error.message);

      if (responseData?.isMaintenance) {
        setMaintenanceNotice({
          title: "Website under maintenance",
          message:
            responseData.message ||
            "Website is under maintenance. Please try again later.",
        });

        setActiveScreen("home");
        return null;
      }

      alert("Unable to connect right now. Please try again.");
      return null;
    }
  };

  const connectSocket = (authToken) => {
    if (!authToken) {
      alert("Unable to connect. Login token missing.");
      return;
    }

    if (socketRef.current) {
      socketRef.current.disconnect();
    }

    const socket = io(API_URL, {
      auth: {
        token: authToken,
      },
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setActiveScreen("chats");
      addLog("Socket connected", socket.id);

      startLocationWatcher(socket);
    });

    socket.on("disconnect", () => {
      setConnected(false);
      setCurrentRoomId("");
      stopLocationWatcher();
      addLog("Socket disconnected");
    });

    socket.on("connect_error", (error) => {
      addLog("Socket connection error", error.message);

      if (error.message?.toLowerCase().includes("maintenance")) {
        setMaintenanceNotice({
          title: "Website under maintenance",
          message: error.message,
        });

        setActiveScreen("home");
        return;
      }

      alert(error.message || "Socket connection failed.");
    });

    socket.on("waiting:joined", (data) => {
      addLog("Joined waiting room", data);
      setActiveScreen("chats");
    });

    socket.on("chat:matched", (data) => {
      setCurrentRoomId(data.roomId);
      setMessages([]);
      setActiveScreen("chats");
      addLog("Matched with nearby user", data);
    });

    socket.on("rooms:available", (data) => {
      addLog("Available rooms received", data);
    });

    socket.on("room:joined", (data) => {
      setCurrentRoomId(data.roomId);
      setActiveScreen("chats");
      addLog("Room joined", data);
    });

    socket.on("room:rejoined", (data) => {
      setCurrentRoomId(data.roomId);
      setActiveScreen("chats");
      addLog("Room rejoined", data);
    });

    socket.on("room:removed", (data) => {
      setCurrentRoomId("");
      setMessages([]);
      setMessageText("");
      setActiveScreen("home");
      addLog("Removed from room", data);
    });

    socket.on("chat:ended", (data) => {
      setCurrentRoomId("");
      setMessages([]);
      setMessageText("");
      setActiveScreen("home");
      addLog("Chat ended", data);
    });

    socket.on("room:user_left", (data) => {
      setCurrentRoomId("");
      setMessages([]);
      setMessageText("");
      setActiveScreen("home");
      addLog("User left room", data);
    });

    socket.on("room:user_left", (data) => {
      addLog("User left room", data);
    });

    socket.on("room:members_updated", (data) => {
      addLog("Room members updated", data);
    });

    socket.on("room:user_location_updated", (data) => {
      addLog("Room user location updated", data);
    });

    socket.on("message:new", (message) => {
      setMessages((prev) => [...prev, message]);
      addLog("New message received", message);
    });

    socket.on("chat:ended", (data) => {
      setCurrentRoomId("");
      setMessages([]);
      addLog("Chat ended", data);
    });

    socket.on("location:updated", (data) => {
      addLog("Location updated event", data);
    });

    socket.on("stats:online_users", (data) => {
      setOnlineUsers(Number(data.onlineUsers || 0));
    });

    socket.on("auth:error", (data) => {
      addLog("Auth error", data);
      alert(data?.message || "Authentication failed.");
    });

    socket.on("app:maintenance", (data) => {
      addLog("Maintenance mode enabled", data);

      setMaintenanceNotice({
        title: "Website under maintenance",
        message:
          data?.message ||
          "Website is under maintenance. Please try again later.",
      });

      stopLocationWatcher();

      setConnected(false);
      setCurrentRoomId("");
      setMessages([]);
      setMessageText("");
      setActiveScreen("home");

      socket.disconnect();
      socketRef.current = null;
    });

    socket.on("app:runtime_config_updated", (data) => {
      addLog("Runtime config updated", data);

      if (data?.Match_Radius) {
        setMatchRadiusMeters(Number(data?.Match_Radius))
      }

      if (data?.isMaintenance) {
        setMaintenanceNotice({
          title: "Website under maintenance",
          message: "Website is under maintenance. Please try again later.",
        });

        stopLocationWatcher();

        setConnected(false);
        setCurrentRoomId("");
        setMessages([]);
        setMessageText("");
        setActiveScreen("home");

        socket.disconnect();
        socketRef.current = null;
      }

    });
  };

  const handleConnectClick = async () => {
    setIsLoggingIn(true);

    const guestUser = generateGuestUser();

    setUserId(guestUser.userId);
    setName(guestUser.name);

    const authToken = await loginGuest(guestUser);

    if (authToken) {
      connectSocket(authToken);
    }

    setIsLoggingIn(false);
  };

  const sendMessage = () => {
    if (!socketRef.current || !socketRef.current.connected) {
      alert("Socket not connected");
      return;
    }

    if (!currentRoomId) {
      alert("You are not connected to a nearby friend yet.");
      return;
    }

    if (!messageText.trim()) {
      return;
    }

    socketRef.current.emit(
      "message:send",
      {
        text: messageText.trim(),
        clientMessageId: uuidv4(),
      },
      (ack) => {
        addLog("Message send ack", ack);
      }
    );

    setMessageText("");
  };

  const leaveRoom = () => {
    if (!socketRef.current) return;

    socketRef.current.emit("room:leave", {}, (ack) => {
      addLog("Leave room ack", ack);
    });

    stopLocationWatcher();

    socketRef.current?.disconnect();
    socketRef.current = null;

    setConnected(false);
    setCurrentRoomId("");
    setMessages([]);
    setActiveScreen("home");
  };

  const isMyMessage = (message) => {
    const from = String(
      message.from || message.userId || message.senderId || message.sender || ""
    );

    return from === userId;
  };

  useEffect(() => {
    return () => {
      stopLocationWatcher();
      socketRef.current?.disconnect();
    };
  }, []);

  return (
    <div className={`app-shell ${activeScreen === "home" ? "home-mode" : "chat-mode"}`}>
      {maintenanceNotice && (
        <MaintenanceStrip notice={maintenanceNotice} />
      )}

      {activeScreen === "home" && locationPermissionNotice && (
        <LocationPermissionStrip
          notice={locationPermissionNotice}
          onRetry={handleConnectClick}
          isLoading={isLoggingIn}
        />
      )}
      <Header
        activeScreen={activeScreen}
        setActiveScreen={setActiveScreen}
        connected={connected}
        displayName={displayName}
        connectionLabel={connectionLabel}
      />

      {activeScreen === "home" ? (
        <LandingPage
          onConnect={handleConnectClick}
          isLoading={isLoggingIn}
          connected={connected}
          connectionLabel={connectionLabel}
          onReturnToChat={() => setActiveScreen("chats")}
          onlineUsers={onlineUsers}
          isMaintenance={Boolean(maintenanceNotice)}
        />
      ) : (
        <ChatPage
          displayName={displayName}
          connected={connected}
          currentRoomId={currentRoomId}
          connectionLabel={connectionLabel}
          messages={messages}
          messageText={messageText}
          setMessageText={setMessageText}
          sendMessage={sendMessage}
          sendImageMessage={sendImageMessage}
          isImageUploading={isImageUploading}
          leaveRoom={leaveRoom}
          isMyMessage={isMyMessage}
          latitude={latitude}
          longitude={longitude}
          isLocationAllowed={isLocationAllowed}
          isWatchingLocation={isWatchingLocation}
          logs={logs}
          matchRadiusMeters={matchRadiusMeters}
        />
      )}
    </div>
  );
}

function MaintenanceStrip({ notice }) {
  return (
    <div className="maintenance-info-strip" role="alert">
      <div className="location-info-main">
        <div className="location-info-icon">🛠️</div>

        <div className="location-info-content">
          <strong>{notice.title}</strong>
          <p>{notice.message}</p>
        </div>
      </div>
    </div>
  );
}

function LocationPermissionStrip({ notice, onRetry, isLoading }) {
  return (
    <div className="location-info-strip" role="alert">
      <div className="location-info-main">
        <div className="location-info-icon">📍</div>

        <div className="location-info-content">
          <strong>{notice.title}</strong>
          <p>{notice.message}</p>
          <span>{notice.steps}</span>
        </div>
      </div>

      <button
        className="permission-retry-btn"
        type="button"
        onClick={onRetry}
        disabled={isLoading}
      >
        {isLoading ? "Checking..." : "Try again"}
      </button>
    </div>
  );
}

function Header({ activeScreen, setActiveScreen, connected, displayName, connectionLabel }) {
  return (
    <header className="topbar">
      <button
        className="brand"
        type="button"
        onClick={() => setActiveScreen("home")}
      >
        <span className="brand-text">
          Fun <span>With</span> Friends
        </span>
      </button>

      <nav className="nav-links">
      </nav>

      <div className="topbar-actions">

        <div className="mini-profile">
          <div className="avatar small">😊</div>
          <div className="name-display">
            <strong>{displayName}</strong>
            <p className="name-display-child">
              <span
                className={
                  connected ? "online-dot-small" : "offline-dot-small"
                }
              ></span>{connectionLabel}
            </p>
          </div>
        </div>
      </div>
    </header>
  );
}

function LandingPage({ onConnect, isLoading, connected, connectionLabel, onReturnToChat, onlineUsers, isMaintenance }) {

  function getOnlineUsersLabel(onlineUsers) {
    const count = Number(onlineUsers || 0);

    if (count <= 0) {
      return "Be the first one to connect now.";
    }

    if (count < 1000) {
      return `${count} ${count === 1 ? "user is" : "users are"} online now`;
    }

    const roundedCount = Math.floor(count / 1000) * 1000;
    const cappedCount = Math.min(roundedCount, 5000);

    return `${cappedCount}+ users are online`;
  }

  return (
    <main className="landing">
      <section className="hero">
        <div className="hero-copy">
          <h1>
            Chat with <span>nearby friends</span>
          </h1>

          <p>
            Meet new people around you, start fun conversations, and make real
            connections.
          </p>

          <button
            className="connect-btn"
            onClick={onConnect}
            disabled={isLoading || connected || isMaintenance}
          >
            {isMaintenance ? "Connect" : isLoading ? "Finding your location..." : connected ? connectionLabel : "Connect"}
            <span>{isLoading ? " ➜ " : "➜"}</span>
          </button>

          <div className="online-users-pill">
            {isMaintenance ? <span className="online-maintenance-dot-small"></span> : <span className="online-dot-small"></span>}

            {isMaintenance ? <p>Please wait until we are back</p> : <p>{getOnlineUsersLabel(onlineUsers)}</p>}
          </div>

          {connected || connectionLabel === "Searching nearby" ? (
            <button
              className="return-chat-btn"
              onClick={onReturnToChat}
              type="button"
            >
              Return to Chat
            </button>
          ) : null}

        </div>

        <div className="hero-art">
          <div className="cloud cloud-one"></div>
          <div className="cloud cloud-two"></div>

          <div className="map-pin">
            <div className="pin-face">☺</div>
          </div>

          <div className="chat-bubble bubble-hi">Hi!</div>
          <div className="chat-bubble bubble-heart">💗</div>

          <div className="friend friend-one">
            <div className="head">👦</div>
            <div className="body yellow"></div>
          </div>

          <div className="friend friend-two">
            <div className="head">👧</div>
            <div className="body purple"></div>
          </div>

          <div className="friend friend-three">
            <div className="head">🧑🏾</div>
            <div className="body green-shirt"></div>
          </div>
        </div>
      </section>

      <section className="features">
        <FeatureCard icon="📍" title="Nearby People">
          Connect with people nearby.
        </FeatureCard>

        <FeatureCard icon="💬" title="Have a quick chat">
          Start and make conversations with strangers.
        </FeatureCard>

        <FeatureCard icon="🙂" title="Have Fun">
          Share laughs, stories, and good vibes!!
        </FeatureCard>
      </section>
    </main>
  );
}

function FeatureCard({ icon, title, children }) {
  return (
    <article className="feature-card">
      <div className="feature-icon">{icon}</div>
      <div>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
    </article>
  );
}

function ChatPage({
  displayName,
  connected,
  currentRoomId,
  connectionLabel,
  messages,
  messageText,
  setMessageText,
  sendMessage,
  sendImageMessage,
  isImageUploading,
  leaveRoom,
  isMyMessage,
  latitude,
  longitude,
  isLocationAllowed,
  isWatchingLocation,
  logs,
  matchRadiusMeters
}) {
  const [showConnectedMessage, setShowConnectedMessage] = useState(false);
  const [previewImage, setPreviewImage] = useState(null);
  const [showInfo, setShowInfo] = useState(false);
  const messagesAreaRef = useRef(null);
  const imageInputRef = useRef(null);
  const menuRef = useRef(null);

  const scrollToLatestMessage = (behavior = "smooth") => {
    requestAnimationFrame(() => {
      const el = messagesAreaRef.current;

      if (!el) return;

      el.scrollTo({
        top: el.scrollHeight,
        behavior,
      });
    });
  };

  useEffect(() => {
    if (!showInfo) return;

    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setShowInfo(false);
      }
    };

    const handleEscapeKey = (event) => {
      if (event.key === "Escape") {
        setShowInfo(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);
    document.addEventListener("keydown", handleEscapeKey);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
      document.removeEventListener("keydown", handleEscapeKey);
    };
  }, [showInfo])

  useEffect(() => {
    scrollToLatestMessage("smooth");
  }, [messages, showConnectedMessage, currentRoomId]);

  useEffect(() => {
    if (!currentRoomId) {
      setShowConnectedMessage(false);
      return;
    }

    setShowConnectedMessage(true);

    const timerId = setTimeout(() => {
      setShowConnectedMessage(false);
    }, 4000);

    return () => clearTimeout(timerId);
  }, [currentRoomId]);

  function dropDownInfo() {
    setShowInfo(!showInfo);
  }

  return (
    <>
      <main className="chat-page">
        <section className="chat-window panel">
          <div className="chat-header">
            <div className="chat-user">
              <div className="avatar">👧</div>
              <div className="name-display">
                <h2>You</h2>
              </div>
            </div>
            <div className="chat-menu-wrapper" ref={menuRef}>
              <button
                type="button"
                className="chat-menu-btn"
                onClick={() => setShowInfo((prev) => !prev)}
              >
                <Menu size={24} />
              </button>

              {showInfo && (
                <div className="chat-dropdown-menu">
                  <InfoRow icon="📍" title="Location">
                    {isLocationAllowed && latitude && longitude
                      ? `${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}`
                      : "Not allowed"}
                  </InfoRow>

                  <InfoRow icon="🎯" title="Room">
                    {currentRoomId || "No room yet"}
                  </InfoRow>

                  <button className="leave-btn" type="button" onClick={leaveRoom}>
                    <p>Leave Chat</p>
                    <LogOut />
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="chat-body">
            {!currentRoomId && (
              <div className="match-banner">
                <span></span>
                <div>
                  <strong>Waiting for a nearby match</strong>
                  <p>Keep this screen open. We’ll connect you automatically.</p>
                </div>
              </div>
            )}

            {currentRoomId && showConnectedMessage && (
              <div className="match-banner connected-banner">
                <span>🎉</span>
                <div>
                  <strong>You're connected nearby!</strong>
                  <p>You and your new friend are nearby each other.</p>
                </div>
              </div>
            )}

            <div className="messages-area" ref={messagesAreaRef}>
              {messages.length === 0 ? (
                <EmptyChatState currentRoomId={currentRoomId} matchRadiusMeters={matchRadiusMeters}/>
              ) : (
                messages.map((message, index) => (
                  <MessageBubble
                    key={message.clientMessageId || message._id || index}
                    message={message}
                    mine={isMyMessage(message)}
                    onImageClick={setPreviewImage}
                  />
                ))
              )}
            </div>
          </div>


          {currentRoomId && <div className="message-input-row">
            <button
              type="button"
              className="emoji-btn"
              disabled={!currentRoomId || isImageUploading}
              onClick={() => imageInputRef.current?.click()}
              title="Send image"
            >
              <ImagePlus size={22} />
            </button>

            <input
              ref={imageInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden-image-input"
              onChange={(e) => {
                const file = e.target.files?.[0];

                if (file) {
                  sendImageMessage(file);
                }

                e.target.value = "";
              }}
            />

            <input
              value={messageText}
              placeholder={
                currentRoomId
                  ? isImageUploading
                    ? "Uploading image..."
                    : "Type a message..."
                  : "Waiting for nearby connection..."
              }
              disabled={!currentRoomId || isImageUploading}
              onChange={(e) => setMessageText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  sendMessage();
                }
              }}
            />

            {currentRoomId && (
              <button
                type="button"
                className="send-btn"
                onClick={sendMessage}
                disabled={!currentRoomId || isImageUploading}
              >
                <Send className="send-btn-icon" />
              </button>
            )}
          </div>}
        </section>
      </main>

      {previewImage && (
        <ImagePreviewModal
          image={previewImage}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </>
  );
}

function EmptyChatState({ currentRoomId, matchRadiusMeters }) {
  return (
    <div className="empty-chat">
      <div className={`empty-icon ${currentRoomId ? "is-floating" : "is-searching"}`}>{currentRoomId ? "💬" : "🔎"}</div> {/*🔎*/}
      <h3>{currentRoomId ? "Say hello!" : `Looking for nearby friends within the radius of ${matchRadiusMeters} meters`}</h3>
    </div>
  );
}

function ImagePreviewModal({ image, onClose }) {
  const [zoom, setZoom] = useState(1);

  const zoomIn = () => {
    setZoom((prev) => Math.min(prev + 0.25, 4));
  };

  const zoomOut = () => {
    setZoom((prev) => Math.max(prev - 0.25, 0.5));
  };

  const resetZoom = () => {
    setZoom(1);
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.body.classList.add("modal-open");
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.classList.remove("modal-open");
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div className="image-preview-overlay" onClick={onClose}>
      <div className="image-preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="image-preview-toolbar">
          <MinusCircle onClick={zoomOut} style={{ cursor: 'pointer' }} />
          <span>{Math.round(zoom * 100)}%</span>
          <PlusCircle onClick={zoomIn} style={{ cursor: 'pointer' }} />
          <button type="button" onClick={resetZoom} style={{ paddingLeft: '10px', paddingRight: '10px', fontFamily: 'ui-serif' }}>
            Reset
          </button>

          <button type="button" className="image-preview-close" onClick={onClose} style={{ paddingLeft: '10px', paddingRight: '10px' }}>
            <X />
          </button>
        </div>

        <div className="image-preview-body">
          <img
            src={image.src}
            alt={image.alt}
            className="image-preview-img"
            style={{
              transform: `scale(${zoom})`,
            }}
            draggable={false}
          />
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message, mine, onImageClick }) {
  const isImageMessage = message.type === "image" && message.imageUrl;

  return (
    <div className={`message-row ${mine ? "mine" : "theirs"}`}>
      {!mine && <div className="avatar tiny">👧</div>}

      <div className={`message-bubble ${isImageMessage ? "image-message-bubble" : ""}`}>
        {isImageMessage ? (
          <button
            type="button"
            className="chat-image-button"
            onClick={() =>
              onImageClick({
                src: message.imageUrl,
                alt: message.fileName || "Shared image",
              })
            }
          >
            <img
              src={message.imageUrl}
              alt={message.fileName || "Shared image"}
              className="chat-image"
              loading="lazy"
            />
          </button>
        ) : (
          <p>{message.text}</p>
        )}

        <span>
          {new Date(message.sentAt || message.createdAt || Date.now()).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
          {/* {mine ? " ✓✓" : ""} */}
        </span>
      </div>
    </div>
  );
}

function InfoRow({ icon, title, children }) {
  return (
    <div className="info-row">
      <span>{icon}</span>
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </div>
  );
}

export default App;
