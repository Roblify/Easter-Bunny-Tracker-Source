// main.js - Easter Bunny Tracker (stats + bunny marker + baskets + camera lock, Mapbox version)

// =====================
// CONFIG
// =====================
const MAPBOX_TOKEN = "pk.eyJ1IjoidGhlcm9ibGlmeSIsImEiOiJjbWp0bzMyM2w0em52M2NxMmZhcGc3NnI2In0.gFxRxRimP3V-WhDvZyf-UA"; // <-- put your Mapbox token here

const BASKET_START_DR = 77;
const CITY_PANEL_MIN_DR = 77;

// Camera settings (in Mapbox zoom levels)
const LOCKED_ZOOM = 5;           // zoom when locked to bunny
const UNLOCKED_MIN_ZOOM = 1.5;     // min zoom when unlocked
const UNLOCKED_MAX_ZOOM = 8.0;     // max zoom when unlocked

const STARTUP_GRACE_SEC = 20;

const STANDARD_STYLE = "mapbox://styles/mapbox/standard";
const SATELLITE_STYLE = "mapbox://styles/mapbox/satellite-streets-v12";

let currentStyle = "standard"; // default

// User settings
let speedUnitMode = "mph";       // "mph" or "kmh"
let streamerModeEnabled = false; // true = hide personal ETA text

let isDelivering = false; // true only while the Bunny is stopped & delivering

const MUSIC_VOLUME = 0.2;

// =====================
// GENERIC HELPERS
// =====================
function $(id) {
    return document.getElementById(id);
}

const fmtInt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
function formatInt(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return "—";
    return fmtInt.format(n);
}

function formatDurationWords(totalSeconds) {
    if (!Number.isFinite(totalSeconds)) return "—";

    let s = Math.max(0, Math.ceil(totalSeconds));

    if (s === 0) return "0 seconds";
    if (s < 2) return "1 second";

    const hours = Math.floor(s / 3600);
    s %= 3600;
    const minutes = Math.floor(s / 60);
    const seconds = s % 60;

    const parts = [];
    if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
    if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds} ${seconds === 1 ? "second" : "seconds"}`);

    return parts.join(", ");
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// =====================
// IP-BASED VIEWER LOCATION
// =====================
async function fetchViewerLocationFromIpInfo() {
    try {
        const res = await fetch("https://ipinfo.io/json?token=e79f246961b6e1", {
            cache: "no-store"
        });
        if (!res.ok) throw new Error(`ipinfo.io failed (${res.status})`);

        const data = await res.json();
        if (!data.loc || typeof data.loc !== "string") {
            throw new Error("ipinfo.io response missing 'loc'");
        }

        const [latStr, lonStr] = data.loc.split(",");
        const lat = parseFloat(latStr);
        const lon = parseFloat(lonStr);

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            throw new Error("ipinfo.io returned non-numeric coordinates");
        }

        return { lat, lon };
    } catch (e) {
        console.warn("Failed to get viewer location from ipinfo.io:", e);
        return null;
    }
}

function findClosestStopByLocation(stops, lat, lon) {
    let best = null;
    let bestDistKm = Infinity;

    for (const s of stops) {
        if (!Number.isFinite(s.Latitude) || !Number.isFinite(s.Longitude)) continue;
        const d = haversineKm(lat, lon, s.Latitude, s.Longitude);
        if (d < bestDistKm) {
            bestDistKm = d;
            best = s;
        }
    }

    return best;
}

// =====================
// WEATHER
// =====================
function weatherCodeToText(code) {
    const c = Number(code);
    if (!Number.isFinite(c)) return "Unknown conditions";

    if (c === 0) return "Clear sky";
    if (c === 1 || c === 2) return "Mostly clear";
    if (c === 3) return "Overcast";
    if (c === 45 || c === 48) return "Foggy";
    if (c === 51 || c === 53 || c === 55) return "Light drizzle";
    if (c === 56 || c === 57) return "Freezing drizzle";
    if (c === 61 || c === 63 || c === 65) return "Rain";
    if (c === 66 || c === 67) return "Freezing rain";
    if (c === 71 || c === 73 || c === 75) return "Snow";
    if (c === 77) return "Snow grains";
    if (c === 80 || c === 81 || c === 82) return "Rain showers";
    if (c === 85 || c === 86) return "Snow showers";
    if (c === 95) return "Thunderstorm";
    if (c === 96 || c === 99) return "Thunderstorm with hail";
    return "Unknown conditions";
}

// =====================
// MISC HELPERS
// =====================
function formatViewerEtaText(deltaSeconds) {
    if (!Number.isFinite(deltaSeconds)) return "Unknown";

    // Negative or already very close: treat as "anytime"
    if (deltaSeconds <= 0 || deltaSeconds < 30 * 60) {
        return "anytime";
    }

    const hours = deltaSeconds / 3600;

    // Round to nearest half-hour
    const halfHours = Math.round(hours * 2);
    const roundedHours = halfHours / 2;

    const whole = Math.floor(roundedHours);
    const frac = roundedHours - whole;

    const isHalf = Math.abs(frac - 0.5) < 1e-6;

    if (!isHalf) {
        const n = roundedHours.toFixed(0);
        return `${n} ${n === "1" ? "hour" : "hours"}`;
    }

    if (whole === 0) {
        return "½ hour";
    }

    return `${whole}½ hours`;
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function wrapDeltaLon(deg) {
    // normalize to [-180, 180)
    return ((deg + 540) % 360) - 180;
}

function normalizeLon(lon) {
    // normalize to [-180, 180)
    return ((lon + 540) % 360) - 180;
}

function interpolateLatLon(a, b, t) {
    const dLon = wrapDeltaLon(b.Longitude - a.Longitude);
    const lon = normalizeLon(a.Longitude + dLon * t);

    return {
        lat: lerp(a.Latitude, b.Latitude, t),
        lon
    };
}

function cityLabel(stop) {
    const city = stop.City || "Unknown";
    const region = stop.Region ? `, ${stop.Region}` : "";
    return `${city}${region}`;
}

function statusCityLabel(stop) {
    if (!stop) return "Unknown";

    const city = stop.City || "Unknown";
    const region = stop.Region || "";
    const dr = Number(stop.DR);

    // Hide region if DR is below 76
    const hideRegion = Number.isFinite(dr) && dr < 76;

    if (hideRegion || !region) {
        return city; // just "City"
    }

    return `${city}, ${region}`; // "City, Region"
}

function toNum(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : x;
}

async function loadRoute() {
    const res = await fetch("./route-testing.json", { cache: "no-store" }); // CHANGE THIS LATER
    if (!res.ok) throw new Error(`Failed to load route.json (${res.status})`);
    const data = await res.json();

    let stops = Array.isArray(data) ? data : data.route || data.stops || [];
    if (!Array.isArray(stops)) throw new Error("route.json format not recognized.");

    stops = stops.map((s) => ({
        ...s,
        DR: toNum(s.DR),
        Latitude: Number(s.Latitude),
        Longitude: Number(s.Longitude),
        EggsDelivered: toNum(s["Eggs Delivered"]),
        CarrotsEaten: toNum(s["Carrots eaten"]),
        UnixArrivalArrival: Number(s["Unix Arrival Arrival"]),
        UnixArrival: Number(s["Unix Arrival"]),
        UnixArrivalDeparture: Number(s["Unix Arrival Departure"]),
        WikipediaUrl: typeof s["Wikipedia attr"] === "string" ? s["Wikipedia attr"] : null,
        Timezone: typeof s["Timezone"] === "string" ? s["Timezone"] : null,

        PopulationNum: Number(s["Population Num"]),
        PopulationYear: toNum(s["Population Year"]),
        ElevationMeter: Number(s["Elevation Meter"])
    }));

    stops.sort((a, b) => a.UnixArrivalArrival - b.UnixArrivalArrival);
    return stops;
}

function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}

function cityOnly(stop) {
    return (stop && stop.City) ? stop.City : "Unknown";
}

// =====================
// MAIN INIT (MAPBOX)
// =====================
(async function init() {
    try {
        if (typeof mapboxgl === "undefined") {
            console.error("Mapbox GL JS is undefined. Make sure its script is loaded.");
            return;
        }

        // CHANGE LATER IF YOU WANT PRE-START REDIRECT
        const PRE_JOURNEY_START_UTC_MS = Date.UTC(2026, 3, 5, 6, 0, 0);
        if (Date.now() < PRE_JOURNEY_START_UTC_MS) {
          window.location.replace("index.html");
          return;
        }

        // Show initial "Loading..." if element exists
        const statDurationEl = $("statDuration");
        if (statDurationEl) {
            statDurationEl.textContent = "Loading...";
        }

        $("statStatus").textContent = "Loading route…";
        const stops = await loadRoute();

        // Mapbox basic setup
        mapboxgl.accessToken = MAPBOX_TOKEN;

        const firstStop = stops[0];

        const map = new mapboxgl.Map({
            container: "cesiumContainer",
            // Mapbox Standard style (required for dawn/day/dusk/night presets)
            style: "mapbox://styles/mapbox/standard",
            center: [firstStop.Longitude, firstStop.Latitude],
            zoom: LOCKED_ZOOM,  // something like 1–1.5 for full globe
            bearing: 0,
            pitch: 0,
            projection: "globe"
        });

        map.on("style.load", () => {

            // Globe projection must always be re-applied after style changes
            map.setProjection("globe");

            if (currentStyle === "standard") {
                // Built-in dusk lighting
                map.setConfigProperty("basemap", "lightPreset", "dusk");

                // Starry dusk sky
                map.setFog({
                    range: [0.6, 8],
                    color: "rgb(186, 210, 235)",
                    "high-color": "rgb(36, 92, 223)",
                    "horizon-blend": 0.02,
                    "space-color": "rgb(11, 11, 25)",
                    "star-intensity": 0.6
                });
            } else {
                // Satellite: still apply globe fog, but no dusk preset
                map.setFog({
                    range: [0.8, 10],
                    "space-color": "rgb(11, 11, 25)",
                    "star-intensity": 0.3
                });
            }
        });

        // Wait for map load before adding markers or using setMinZoom/setMaxZoom
        await new Promise((resolve) => map.on("load", resolve));

        const mapStyleBtn = document.getElementById("mapStyleBtn");

        function toggleMapStyle() {

            // Save current camera
            const center = map.getCenter();
            const zoom = map.getZoom();
            const bearing = map.getBearing();
            const pitch = map.getPitch();

            // Flip mode
            const toSatellite = (currentStyle === "standard");

            currentStyle = toSatellite ? "satellite" : "standard";

            // Update button
            if (mapStyleBtn) {
                mapStyleBtn.setAttribute("aria-pressed", String(!toSatellite));
                mapStyleBtn.textContent = toSatellite
                    ? "Map style: Satellite"
                    : "Map style: Standard";
            }

            // Apply style (will trigger style.load again)
            map.setStyle(toSatellite ? SATELLITE_STYLE : STANDARD_STYLE);

            // Restore camera as soon as the style finishes loading
            map.once("style.load", () => {
                map.jumpTo({ center, zoom, bearing, pitch });
            });
        }

        if (mapStyleBtn) {
            mapStyleBtn.addEventListener("click", toggleMapStyle);
        }

        map.setMinZoom(UNLOCKED_MIN_ZOOM);
        map.setMaxZoom(UNLOCKED_MAX_ZOOM);

        // Final DR (journey end)
        const FINAL_DR = 1048;
        const finalStop =
            stops.find(s => Number(s.DR) === FINAL_DR) ||
            stops[stops.length - 1];
        const FINAL_ARRIVAL = Number(finalStop.UnixArrivalArrival);

        // Rows for Status and Arriving in
        const statStatusRow = (() => {
            const v = $("statStatus");
            const row = v ? v.closest(".hud-row") : null;
            return row || null;
        })();

        const statEtaRow = (() => {
            const v = $("statEta");
            const row = v ? v.closest(".hud-row") : null;
            return row || null;
        })();

        // Viewer-location based ETA state
        let viewerLocation = null;
        let viewerClosestStop = null;
        let viewerEtaError = false;

        // City info panel DOM
        const cityPanel = $("cityPanel");
        const cityTitleEl = $("cityTitle");
        const cityLocalTimeEl = $("cityLocalTime");
        const cityWeatherEl = $("cityWeather");
        const cityPopulationEl = $("cityPopulation");
        const cityElevationEl = $("cityElevation");
        const cityDirectionEl = $("cityDirection");

        let currentTravelDirection = null;

        // Live city data state
        let currentCityStop = null;
        let currentCityTimezone = null;
        let currentCityWeatherText = null;
        let currentCityWeatherFetchPromise = null;

        async function fetchCityLiveWeather(stop) {
            if (!stop) return null;

            // If we're already fetching for this stop, reuse the promise
            if (currentCityWeatherFetchPromise && currentCityStop === stop) {
                return currentCityWeatherFetchPromise;
            }

            const lat = stop.Latitude;
            const lon = stop.Longitude;
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                return null;
            }

            const url =
                `https://api.open-meteo.com/v1/forecast` +
                `?latitude=${encodeURIComponent(lat)}` +
                `&longitude=${encodeURIComponent(lon)}` +
                `&current_weather=true` +
                `&timezone=auto`;

            currentCityWeatherFetchPromise = (async () => {
                try {
                    const res = await fetch(url, { cache: "no-store" });
                    if (!res.ok) throw new Error(`weather HTTP ${res.status}`);
                    const data = await res.json();
                    const cw = data.current_weather;
                    if (!cw) return null;

                    const tempC = Number(cw.temperature);
                    const tempF = Number.isFinite(tempC) ? (tempC * 9) / 5 + 32 : NaN;
                    const code = cw.weathercode;
                    const conditions = weatherCodeToText(code);

                    currentCityTimezone = data.timezone || null;
                    currentCityWeatherText = Number.isFinite(tempC) && Number.isFinite(tempF)
                        ? `${tempC.toFixed(1)} °C / ${tempF.toFixed(1)} °F, ${conditions}`
                        : conditions || "Unknown";

                    return {
                        timezone: currentCityTimezone,
                        weatherText: currentCityWeatherText
                    };
                } catch (err) {
                    console.warn("City weather fetch failed:", err);
                    currentCityTimezone = null;
                    currentCityWeatherText = "Unknown";
                    return null;
                }
            })();

            return currentCityWeatherFetchPromise;
        }

        // Kick off IP-based location lookup (non-blocking)
        fetchViewerLocationFromIpInfo().then((loc) => {
            if (!loc) {
                viewerEtaError = true;
                if (statDurationEl) statDurationEl.textContent = "Unknown";
                return;
            }

            viewerLocation = loc;
            viewerClosestStop = findClosestStopByLocation(stops, loc.lat, loc.lon);
        }).catch((err) => {
            console.warn("Viewer location lookup failed:", err);
            viewerEtaError = true;
            if (statDurationEl) statDurationEl.textContent = "Unknown";
        });

        // Find when DR 77 begins:
        // Prefer exact DR 77; fallback to first DR >= 77 if exact doesn't exist
        const dr77Stop =
            stops.find(s => Number(s.DR) === BASKET_START_DR) ||
            stops.find(s => Number(s.DR) >= BASKET_START_DR);

        const DR77_ARRIVAL = dr77Stop ? Number(dr77Stop.UnixArrivalArrival) : null;

        // Grab the label span that sits next to #statEta (the first span in that hud-row)
        const statEtaLabelEl = (() => {
            const v = document.getElementById("statEta");
            const row = v ? v.closest(".hud-row") : null;
            return row ? row.querySelector("span:first-child") : null;
        })();

        function setEtaLabel(isBefore77) {
            if (!statEtaLabelEl) return;
            statEtaLabelEl.textContent = isBefore77 ? "Countdown to takeoff:" : "Arriving in:";
        }

        // =====================
        // MAP MARKERS (BUNNY + BASKETS)
        // =====================
        let bunnyMarker = null;
        const basketMarkers = new Map();

        function createBunnyMarker(initialStop) {
            const img = document.createElement("img");
            img.src = "Bunny.png";
            img.alt = "Easter Bunny";
            img.style.width = "37px";
            img.style.height = "37px";
            img.style.transform = "translateY(4px)"; // slight adjustment so it sits nice
            img.style.pointerEvents = "none";

            bunnyMarker = new mapboxgl.Marker({
                element: img,
                anchor: "bottom"
            })
                .setLngLat([initialStop.Longitude, initialStop.Latitude])
                .addTo(map);
        }

        function updateBunnyPosition(lon, lat) {
            if (!bunnyMarker) return;
            bunnyMarker.setLngLat([lon, lat]);
        }

        function addBasketForStop(stop) {
            const dr = Number(stop.DR);
            if (Number.isFinite(dr) && dr < BASKET_START_DR) return;

            const key = stop.DR ?? `${stop.UnixArrival}`;
            if (basketMarkers.has(key)) return;

            const cityName = cityLabel(stop);

            // Default: just show the city name
            let descHtml = cityName;

            // If we have a Wikipedia URL, make the city name a clickable link
            if (stop.WikipediaUrl) {
                const safeUrl = stop.WikipediaUrl;
                descHtml =
                    `More info: <a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${cityName}</a>`;
            }

            const img = document.createElement("img");
            img.src = "Basket.png";
            img.alt = cityName;
            img.style.width = "24px";
            img.style.height = "24px";

            const marker = new mapboxgl.Marker({
                element: img,
                anchor: "bottom"
            })
                .setLngLat([stop.Longitude, stop.Latitude]);

            const popup = new mapboxgl.Popup({ offset: 24 }).setHTML(descHtml);
            marker.setPopup(popup);

            marker.addTo(map);
            basketMarkers.set(key, marker);
        }

        createBunnyMarker(firstStop);

        // =====================
        // Egg pop FX (Egg.png above bunny while delivering)
        // =====================
        const eggImg = document.createElement("img");
        eggImg.src = "Egg.png";
        eggImg.alt = "";
        eggImg.style.position = "absolute";
        eggImg.style.width = "22px";
        eggImg.style.height = "26px";
        eggImg.style.pointerEvents = "none";
        eggImg.style.opacity = "0";          // start invisible
        eggImg.style.zIndex = "2";           // above map, below HUD (HUD is 9999)
        eggImg.style.transform = "translate(-50%, -100%)"; // center horizontally, above point

        document.body.appendChild(eggImg);

        function updateEggFx(timestamp) {
            if (!bunnyMarker) {
                requestAnimationFrame(updateEggFx);
                return;
            }

            // If not delivering, keep egg hidden
            if (!isDelivering) {
                eggImg.style.opacity = "0";
                requestAnimationFrame(updateEggFx);
                return;
            }

            // 0..1 phase repeating every second
            const phase = (timestamp / 1000) % 1;
            const fadeIn = 0.15;
            const fadeOut = 0.20;

            let a = 1;
            if (phase < fadeIn) {
                a = phase / fadeIn;                      // fade in
            } else if (phase > 1 - fadeOut) {
                a = (1 - phase) / fadeOut;              // fade out
            }

            // Base position = bunny screen position
            const lngLat = bunnyMarker.getLngLat();
            const pt = map.project(lngLat);

            const risePx = phase * 28;                // how high it floats per cycle
            const baseAboveBunny = 44;                // px above bunny "head"

            eggImg.style.left = `${pt.x}px`;
            eggImg.style.top = `${pt.y - baseAboveBunny - risePx}px`;
            eggImg.style.opacity = `${Math.max(0, Math.min(1, a))}`;

            requestAnimationFrame(updateEggFx);
        }

        // Start the animation loop
        requestAnimationFrame(updateEggFx);

        // =====================
        // CAMERA LOCK STATE
        // =====================
        let isLocked = false;

        function setLocked(nextLocked) {
            isLocked = !!nextLocked;

            const btn = $("lockBtn");
            if (btn) {
                btn.setAttribute("aria-pressed", String(isLocked));
                btn.textContent = isLocked ? "🔓 Unlock Camera" : "🔒 Lock to Bunny";
                btn.title = isLocked ? "Unlock camera" : "Lock camera to Bunny";
            }

            if (isLocked) {
                // Disable user interaction
                map.dragPan.disable();
                map.scrollZoom.disable();
                map.boxZoom.disable();
                map.dragRotate.disable();
                map.keyboard.disable();
                map.doubleClickZoom.disable();
                map.touchZoomRotate.disable();

                // Center on bunny
                if (bunnyMarker) {
                    const ll = bunnyMarker.getLngLat();
                    map.easeTo({
                        center: ll,
                        zoom: LOCKED_ZOOM,
                        pitch: 0,
                        bearing: 0,
                        duration: 800
                    });
                }
            } else {
                // Enable interaction
                map.dragPan.enable();
                map.scrollZoom.enable();
                map.boxZoom.enable();
                map.dragRotate.enable();
                map.keyboard.enable();
                map.doubleClickZoom.enable();
                map.touchZoomRotate.enable();

                map.setMinZoom(UNLOCKED_MIN_ZOOM);
                map.setMaxZoom(UNLOCKED_MAX_ZOOM);
            }
        }

        function followBunnyIfLocked() {
            if (!isLocked || !bunnyMarker) return;
            const ll = bunnyMarker.getLngLat();
            map.jumpTo({
                center: ll,
                zoom: LOCKED_ZOOM,
                pitch: 0,
                bearing: 0
            });
        }

        // Start LOCKED by default
        setLocked(true);

        // =====================
        // HUD + SETTINGS
        // =====================
        function updateHUD({
            status,
            lastText,
            etaSeconds,
            etaText,                 // optional override
            stopRemainingSeconds,
            speedKmh,
            speedMph,
            eggs,
            carrots
        }) {
            $("statStatus").textContent = status ?? "—";
            $("statLast").textContent = lastText ?? "—";

            $("statEta").textContent = (typeof etaText === "string")
                ? etaText
                : formatDurationWords(etaSeconds);

            $("statStopRemaining").textContent = formatDurationWords(stopRemainingSeconds);

            if (Number.isFinite(speedKmh) && Number.isFinite(speedMph)) {
                const kmRounded = Math.round(speedKmh);
                const mphRounded = Math.round(speedMph);

                const kmStr = Math.abs(kmRounded) >= 1000
                    ? formatInt(kmRounded)
                    : kmRounded.toString();

                const mphStr = Math.abs(mphRounded) >= 1000
                    ? formatInt(mphRounded)
                    : mphRounded.toString();

                let speedText;
                if (speedUnitMode === "kmh") {
                    speedText = `${kmStr} km/h`;
                } else {
                    speedText = `${mphStr} mph`;
                }

                $("statSpeed").textContent = speedText;
            } else {
                $("statSpeed").textContent = "—";
            }

            $("statEggs").textContent = formatInt(eggs);
            $("statCarrots").textContent = formatInt(carrots);
        }

        function findSegment(now) {
            const first = stops[0];
            const last = stops[stops.length - 1];

            // Grace: if we are only a little late, still treat as being at the first stop
            if (now >= first.UnixArrivalArrival && now < first.UnixArrivalDeparture + STARTUP_GRACE_SEC) {
                return { mode: "stop", i: 0 };
            }

            if (now < first.UnixArrivalArrival) return { mode: "pre" };

            for (let i = 0; i < stops.length; i++) {
                const s = stops[i];
                if (now >= s.UnixArrivalArrival && now < s.UnixArrivalDeparture) return { mode: "stop", i };
                if (now < s.UnixArrivalArrival) return { mode: "travel", from: i - 1, to: i };
            }
            // After the loop, we're past the last departure: treat as "travel" between last two,
            // clamped to t=1, which effectively parks him at the final city.
            return { mode: "travel", from: stops.length - 2, to: stops.length - 1 };
        }

        function isBeforeDR77ForSegment(seg, stops) {
            if (seg.mode === "pre") return true;

            if (seg.mode === "travel") {
                const to = stops[seg.to];
                const dr = Number(to?.DR);
                return Number.isFinite(dr) && dr < BASKET_START_DR;
            }

            if (seg.mode === "stop") {
                const s = stops[seg.i];
                const dr = Number(s?.DR);
                return Number.isFinite(dr) && dr < BASKET_START_DR;
            }

            return false;
        }

        // ETA override:
        // Before DR77 happens, statEta counts down to DR77.
        // After DR77, statEta counts down to "next" like normal.
        function etaForHUD(now, normalEtaSeconds) {
            if (Number.isFinite(DR77_ARRIVAL) && now < DR77_ARRIVAL) {
                return DR77_ARRIVAL - now;
            }
            return normalEtaSeconds;
        }

        function updateViewerLocationEta(now) {
            const el = $("statDuration");
            if (!el) return;

            if (streamerModeEnabled) {
                el.textContent = "HIDDEN | S.M. enabled";
                return;
            }

            // If we failed earlier
            if (viewerEtaError) {
                if (!el.textContent || el.textContent === "Loading...") {
                    el.textContent = "Unknown";
                }
                return;
            }

            // Still resolving IP / closest stop
            if (!viewerClosestStop) {
                // Don't spam; leave as "Loading..." until it's ready
                return;
            }

            const arrival = Number(viewerClosestStop.UnixArrivalArrival);
            if (!Number.isFinite(arrival)) {
                el.textContent = "Unknown";
                return;
            }

            const deltaSeconds = arrival - now;
            const text = formatViewerEtaText(deltaSeconds);

            el.textContent = text;
        }

        function computeTravelDirection(fromStop, toStop) {
            if (!fromStop || !toStop) return null;

            const lat1 = fromStop.Latitude;
            const lon1 = fromStop.Longitude;
            const lat2 = toStop.Latitude;
            const lon2 = toStop.Longitude;

            if (
                !Number.isFinite(lat1) || !Number.isFinite(lon1) ||
                !Number.isFinite(lat2) || !Number.isFinite(lon2)
            ) {
                return null;
            }

            const toRad = (d) => (d * Math.PI) / 180;
            const toDeg = (r) => (r * 180) / Math.PI;

            const φ1 = toRad(lat1);
            const φ2 = toRad(lat2);
            const Δλ = toRad(lon2 - lon1);

            const y = Math.sin(Δλ) * Math.cos(φ2);
            const x =
                Math.cos(φ1) * Math.sin(φ2) -
                Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

            let brng = toDeg(Math.atan2(y, x)); // -180..+180
            brng = (brng + 360) % 360;          // 0..360, 0 = North

            const labels = [
                "North",
                "North-East",
                "East",
                "South-East",
                "South",
                "South-West",
                "West",
                "North-West"
            ];

            const arrows = [
                "↑",  // North
                "↗",  // NE
                "→",  // E
                "↘",  // SE
                "↓",  // S
                "↙",  // SW
                "←",  // W
                "↖"   // NW
            ];

            const sector = Math.round(brng / 45) % 8;
            return {
                text: labels[sector],
                arrow: arrows[sector]
            };
        }

        function updateCityPanel(now, seg) {
            if (!cityPanel) return;

            // Hide if journey complete
            if (Number.isFinite(FINAL_ARRIVAL) && now >= FINAL_ARRIVAL) {
                cityPanel.hidden = true;
                currentCityStop = null;
                return;
            }

            // Decide which stop represents the "current city"
            let s = null;

            if (seg && seg.mode === "stop") {
                s = stops[seg.i];
            } else if (seg && seg.mode === "travel") {
                s = stops[seg.to];
            } else {
                // PRE-JOURNEY (seg.mode === "pre") → show first stop
                s = stops[0];
            }

            if (!s) {
                cityPanel.hidden = true;
                currentCityStop = null;
                return;
            }

            const dr = Number(s.DR);
            // Only show for DR >= CITY_PANEL_MIN_DR
            if (!Number.isFinite(dr) || dr < CITY_PANEL_MIN_DR) {
                cityPanel.hidden = true;
                currentCityStop = null;
                return;
            }

            cityPanel.hidden = false;
            currentCityStop = s;

            // Title: "Information about City"
            if (cityTitleEl) {
                const city = s.City || "Unknown city";
                cityTitleEl.textContent = `Information about: ${city}`;
            }

            if (cityPopulationEl) {
                const pop = Number(s.PopulationNum);
                const year = s.PopulationYear;

                // Treat 0 or non-finite as "Unknown"
                if (Number.isFinite(pop) && pop > 0) {
                    cityPopulationEl.textContent = year
                        ? `${formatInt(pop)} (as of ${year})`
                        : formatInt(pop);
                } else {
                    cityPopulationEl.textContent = "Unknown";
                }
            }

            if (cityElevationEl) {
                const elev = Number(s.ElevationMeter);
                if (Number.isFinite(elev)) {
                    cityElevationEl.textContent = `${formatInt(elev)} meters`;
                } else {
                    cityElevationEl.textContent = "Unknown";
                }
            }

            if (cityDirectionEl) {
                if (currentTravelDirection) {
                    cityDirectionEl.textContent =
                        `${currentTravelDirection.arrow} | ${currentTravelDirection.text}`;
                } else {
                    cityDirectionEl.textContent = "N/A";
                }
            }

            if (cityLocalTimeEl) {
                if (currentCityTimezone) {
                    const nowDate = new Date();
                    try {
                        cityLocalTimeEl.textContent = nowDate.toLocaleTimeString(undefined, {
                            timeZone: currentCityTimezone,
                            hour: "numeric",
                            minute: "2-digit"
                        });
                    } catch {
                        cityLocalTimeEl.textContent = nowDate.toLocaleTimeString(undefined, {
                            hour: "numeric",
                            minute: "2-digit"
                        });
                    }
                } else {
                    cityLocalTimeEl.textContent = "Loading…";
                }
            }

            if (cityWeatherEl) {
                if (currentCityWeatherText) {
                    cityWeatherEl.textContent = currentCityWeatherText;
                } else {
                    cityWeatherEl.textContent = "Loading…";
                }
            }

            if (currentCityStop === s && !currentCityWeatherText) {
                fetchCityLiveWeather(s).then((info) => {
                    if (!info) {
                        if (cityWeatherEl) cityWeatherEl.textContent = "Unknown";
                        if (cityLocalTimeEl && !currentCityTimezone) {
                            cityLocalTimeEl.textContent = "Unknown";
                        }
                        return;
                    }

                    if (cityWeatherEl) cityWeatherEl.textContent = info.weatherText || "Unknown";

                    if (cityLocalTimeEl && info.timezone) {
                        const nowDate = new Date();
                        try {
                            cityLocalTimeEl.textContent = nowDate.toLocaleTimeString(undefined, {
                                timeZone: info.timezone,
                                hour: "numeric",
                                minute: "2-digit"
                            });
                        } catch {
                            cityLocalTimeEl.textContent = nowDate.toLocaleTimeString(undefined, {
                                hour: "numeric",
                                minute: "2-digit"
                            });
                        }
                    }
                });
            }
        }

        // =====================
        // HELP MODAL
        // =====================
        const helpBtn = $("helpBtn");
        const helpOverlay = $("helpOverlay");
        const helpCloseBtn = $("helpCloseBtn");

        function openHelp() {
            if (!helpOverlay) return;
            helpOverlay.classList.add("is-open");
            helpOverlay.setAttribute("aria-hidden", "false");

            const activeTab = helpOverlay.querySelector(".help-tab.is-active");
            if (activeTab) activeTab.focus();
        }

        function closeHelp() {
            if (!helpOverlay) return;
            helpOverlay.classList.remove("is-open");
            helpOverlay.setAttribute("aria-hidden", "true");
            if (helpBtn) helpBtn.focus();
        }

        function setHelpTab(tabKey) {
            if (!helpOverlay) return;

            const tabs = helpOverlay.querySelectorAll(".help-tab");
            const panes = helpOverlay.querySelectorAll(".help-pane");

            tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.tab === tabKey));
            panes.forEach((p) => p.classList.toggle("is-active", p.dataset.pane === tabKey));
        }

        if (helpBtn) helpBtn.addEventListener("click", openHelp);
        if (helpCloseBtn) helpCloseBtn.addEventListener("click", closeHelp);

        const helpTabs = helpOverlay ? helpOverlay.querySelector(".help-tabs") : null;
        if (helpTabs) {
            helpTabs.addEventListener("click", (e) => {
                const btn = e.target.closest(".help-tab");
                if (!btn) return;
                e.preventDefault();
                setHelpTab(btn.dataset.tab);
            });
        }

        window.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            if (!helpOverlay) return;
            if (!helpOverlay.classList.contains("is-open")) return;
            closeHelp();
        });

        // =====================
        // BACKGROUND MUSIC
        // =====================
        let musicEnabled = true;
        let bgAudio = null;
        let musicResumePending = false;

        function initBgMusic() {
            if (bgAudio) return;

            bgAudio = new Audio("music.mp3");
            bgAudio.loop = false;
            bgAudio.volume = MUSIC_VOLUME;

            bgAudio.addEventListener("ended", () => {
                if (!musicEnabled) return;
                setTimeout(() => {
                    if (!musicEnabled || !bgAudio) return;
                    try {
                        bgAudio.currentTime = 0;
                        const p = bgAudio.play();
                        if (p && typeof p.then === "function") {
                            p.then(() => {
                                musicResumePending = false;
                            }).catch(() => {
                                musicResumePending = true;
                            });
                        }
                    } catch (e) {
                        console.warn("Background music replay failed:", e);
                        musicResumePending = true;
                    }
                }, 1000);
            });

            try {
                const p = bgAudio.play();
                if (p && typeof p.then === "function") {
                    p.then(() => {
                        musicResumePending = false;
                    }).catch((err) => {
                        console.warn("Autoplay for background music was blocked by the browser:", err);
                        musicResumePending = true;
                    });
                }
            } catch (e) {
                console.warn("Background music initial play failed:", e);
                musicResumePending = true;
            }
        }

        function setMusicEnabled(next) {
            musicEnabled = !!next;

            const btn = $("musicToggleBtn");
            if (btn) {
                btn.setAttribute("aria-pressed", String(musicEnabled));
                btn.textContent = musicEnabled ? "Music: On" : "Music: Off";
            }

            if (!bgAudio) {
                if (musicEnabled) {
                    initBgMusic();
                }
                return;
            }

            if (musicEnabled) {
                try {
                    const p = bgAudio.play();
                    if (p && typeof p.then === "function") {
                        p.then(() => {
                            musicResumePending = false;
                        }).catch(() => {
                            musicResumePending = true;
                        });
                    }
                } catch (e) {
                    console.warn("Background music play failed:", e);
                    musicResumePending = true;
                }
            } else {
                bgAudio.pause();
                musicResumePending = false;
            }
        }

        function handleUserInteractionForMusic() {
            if (!musicEnabled || !bgAudio || !musicResumePending) return;

            musicResumePending = false;
            try {
                const p = bgAudio.play();
                if (p && typeof p.then === "function") {
                    p.catch(() => {
                        // ignore
                    });
                }
            } catch (e) {
                console.warn("Background music resume on interaction failed:", e);
            }
        }

        ["pointerdown", "click", "keydown", "touchstart"].forEach((ev) => {
            window.addEventListener(ev, handleUserInteractionForMusic, { passive: true });
        });

        const musicToggleBtn = $("musicToggleBtn");
        if (musicToggleBtn) {
            musicToggleBtn.addEventListener("click", () => {
                setMusicEnabled(!musicEnabled);
                if (musicEnabled && !bgAudio) {
                    initBgMusic();
                }
            });
        }

        // Start with music ON by default
        setMusicEnabled(true);
        initBgMusic();

        // =====================
        // SETTINGS BUTTONS
        // =====================
        function updateSpeedUnitButton() {
            const btn = $("travelSpeedTypeBtn");
            if (!btn) return;

            const isMph = (speedUnitMode === "mph");

            btn.setAttribute("aria-pressed", String(isMph));
            btn.textContent = isMph
                ? "Distance converted in: MPH"
                : "Distance converted in: KM/H";
        }

        const travelSpeedTypeBtn = $("travelSpeedTypeBtn");
        if (travelSpeedTypeBtn) {
            travelSpeedTypeBtn.addEventListener("click", () => {
                speedUnitMode = (speedUnitMode === "mph") ? "kmh" : "mph";
                updateSpeedUnitButton();
            });
        }
        updateSpeedUnitButton();

        function updateStreamerModeButton() {
            const btn = $("streamerModeBtn");
            if (!btn) return;

            btn.setAttribute("aria-pressed", String(streamerModeEnabled));
            btn.textContent = streamerModeEnabled
                ? "Streamer Mode: Enabled"
                : "Streamer Mode: Disabled";
        }

        const streamerModeBtn = $("streamerModeBtn");
        if (streamerModeBtn) {
            streamerModeBtn.addEventListener("click", () => {
                streamerModeEnabled = !streamerModeEnabled;
                updateStreamerModeButton();

                updateViewerLocationEta(Date.now() / 1000);
            });
        }
        updateStreamerModeButton();

        const lockBtn = $("lockBtn");
        if (lockBtn) {
            lockBtn.addEventListener("click", () => setLocked(!isLocked));
        }

        // =====================
        // TICK LOOP
        // =====================
        function tick() {
            const now = Date.now() / 1000; // keep fractional seconds

            isDelivering = false;

            const seg = findSegment(now);

            // Always add baskets for completed stops, even after DR 1048
            for (const s of stops) {
                if (now >= s.UnixArrivalDeparture) addBasketForStop(s);
                else break;
            }

            const journeyComplete =
                Number.isFinite(FINAL_ARRIVAL) && now >= FINAL_ARRIVAL;

            if (journeyComplete) {
                if (cityPanel) cityPanel.hidden = true;

                // Park bunny at the final stop
                updateBunnyPosition(finalStop.Longitude, finalStop.Latitude);

                // Hide Status and Arriving in rows
                if (statStatusRow) statStatusRow.style.display = "none";
                if (statEtaRow) statEtaRow.style.display = "none";

                // Freeze eggs/carrots at final values
                updateHUD({
                    status: "",
                    lastText: cityLabel(finalStop),
                    etaSeconds: NaN,
                    etaText: "",
                    stopRemainingSeconds: NaN,
                    speedKmh: NaN,
                    speedMph: NaN,
                    eggs: finalStop.EggsDelivered,
                    carrots: finalStop.CarrotsEaten
                });

                followBunnyIfLocked();
                updateViewerLocationEta(now);
                return;
            }

            const beforeDR77 = Number.isFinite(DR77_ARRIVAL) && now < DR77_ARRIVAL;
            setEtaLabel(beforeDR77);

            const before77 = isBeforeDR77ForSegment(seg, stops);

            if (seg.mode === "pre") {
                const first = stops[0];
                updateBunnyPosition(first.Longitude, first.Latitude);

                updateHUD({
                    status: "Preparing for takeoff…",
                    lastText: "N/A",
                    nextText: before77 ? cityOnly(first) : cityLabel(first),
                    etaSeconds: etaForHUD(now, first.UnixArrivalArrival - now),
                    stopRemainingSeconds: NaN,
                    speedKmh: NaN,
                    speedMph: NaN,
                    eggs: 0,
                    carrots: 0
                });

                followBunnyIfLocked();
                currentTravelDirection = null;
                updateViewerLocationEta(now);
                updateCityPanel(now, seg);
                return;
            }

            if (seg.mode === "stop") {
                const s = stops[seg.i];
                const next = stops[Math.min(seg.i + 1, stops.length - 1)];

                isDelivering = true;
                updateBunnyPosition(s.Longitude, s.Latitude);

                const stopRemaining = s.UnixArrivalDeparture - now;

                let speedKmh = NaN;
                let speedMph = NaN;
                let prevEggsTotal = 0;
                let prevCarrotsTotal = 0;

                if (seg.i > 0) {
                    const prev = stops[seg.i - 1];

                    const distKm = haversineKm(prev.Latitude, prev.Longitude, s.Latitude, s.Longitude);
                    const travelSec = Math.max(1, s.UnixArrivalArrival - prev.UnixArrivalDeparture);
                    speedKmh = (distKm / travelSec) * 3600;
                    speedMph = speedKmh * 0.621371;

                    prevEggsTotal = Number(prev.EggsDelivered) || 0;
                    prevCarrotsTotal = Number(prev.CarrotsEaten) || 0;
                }

                const cityEggsTotal = Number(s.EggsDelivered) || prevEggsTotal;
                const cityCarrotsTotal = Number(s.CarrotsEaten) || prevCarrotsTotal;

                const stopDuration = Math.max(1, s.UnixArrivalDeparture - s.UnixArrivalArrival);
                const stopT = clamp01((now - s.UnixArrivalArrival) / stopDuration);

                const eggsNow = lerp(prevEggsTotal, cityEggsTotal, stopT);
                const carrotsNow = lerp(prevCarrotsTotal, cityCarrotsTotal, stopT);

                updateHUD({
                    status: `Delivering in ${s.City}`,
                    lastText: before77 ? "N/A" : (seg.i > 0 ? cityLabel(stops[seg.i - 1]) : "—"),
                    nextText: next ? (before77 ? cityOnly(next) : cityLabel(next)) : "—",
                    etaText: `Currently delivering eggs in ${s.City}`,
                    etaSeconds: NaN,
                    stopRemainingSeconds: stopRemaining,
                    speedKmh,
                    speedMph,
                    eggs: eggsNow,
                    carrots: carrotsNow
                });

                followBunnyIfLocked();
                currentTravelDirection = null;
            } else if (seg.mode === "travel") {
                const from = stops[seg.from];
                const to = stops[seg.to];
                if (!from || !to) return;

                const toDr = Number(to.DR);

                const showRegionInStatus = Number.isFinite(toDr) && toDr >= 76;
                const destinationLabelForStatus = showRegionInStatus
                    ? cityLabel(to)
                    : cityOnly(to);

                const showHeadingPrefix = Number.isFinite(toDr) && toDr >= 76;
                const statusText = showHeadingPrefix
                    ? `Heading to: ${destinationLabelForStatus}`
                    : destinationLabelForStatus;

                const departT = from.UnixArrivalDeparture;
                const arriveT = to.UnixArrivalArrival;
                const denom = Math.max(1, arriveT - departT);
                const t = clamp01((now - departT) / denom);

                const pos = interpolateLatLon(from, to, t);
                updateBunnyPosition(pos.lon, pos.lat);

                const distKm = haversineKm(from.Latitude, from.Longitude, to.Latitude, to.Longitude);
                const speedKmh = (distKm / denom) * 3600;
                const speedMph = speedKmh * 0.621371;

                const eggs = lerp(Number(from.EggsDelivered) || 0, Number(to.EggsDelivered) || 0, t);
                const carrots = lerp(Number(from.CarrotsEaten) || 0, Number(to.CarrotsEaten) || 0, t);

                updateHUD({
                    status: statusText,
                    lastText: before77 ? "N/A" : cityLabel(from),
                    nextText: before77 ? cityOnly(to) : cityLabel(to),
                    etaSeconds: etaForHUD(now, arriveT - now),
                    stopRemainingSeconds: NaN,
                    speedKmh,
                    speedMph,
                    eggs,
                    carrots
                });

                followBunnyIfLocked();
                currentTravelDirection = computeTravelDirection(from, to);
            }

            updateViewerLocationEta(now);
            updateCityPanel(now, seg);
        }

        tick();
        setInterval(tick, 250);

        console.log(`Loaded route with ${stops.length} stops (Mapbox globe).`);
    } catch (e) {
        console.error("Tracker init failed:", e);
        const el = document.getElementById("statStatus");
        if (el) el.textContent = "Error (see console)";
    }
})();
