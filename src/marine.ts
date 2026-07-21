import type { AppConfig } from "./config.js";

export type MarineConditions = {
  weather: string;
  high_tides: string;
  low_tides: string;
  high_tide_label: string;
  /** ISO timestamp when conditions were fetched. */
  as_of: string;
};

const WMO_LABELS: Record<number, string> = {
  0: "Clear",
  1: "Mostly Clear",
  2: "Partly Cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Icy Fog",
  51: "Light Drizzle",
  53: "Drizzle",
  55: "Heavy Drizzle",
  56: "Freezing Drizzle",
  57: "Freezing Drizzle",
  61: "Light Rain",
  63: "Rain",
  65: "Heavy Rain",
  66: "Freezing Rain",
  67: "Freezing Rain",
  71: "Light Snow",
  73: "Snow",
  75: "Heavy Snow",
  77: "Snow Grains",
  80: "Rain Showers",
  81: "Rain Showers",
  82: "Heavy Showers",
  85: "Snow Showers",
  86: "Snow Showers",
  95: "Thunderstorm",
  96: "Thunderstorm",
  99: "Thunderstorm",
};

function windDirLabel(degrees: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round((((degrees % 360) + 360) % 360) / 45) % 8;
  return dirs[idx] ?? "N";
}

function formatClock(dateTime: string): string {
  // NOAA: "2026-07-20 05:40" or ISO
  const timePart = dateTime.includes("T")
    ? dateTime.split("T")[1]?.slice(0, 5)
    : dateTime.split(" ")[1]?.slice(0, 5);
  if (!timePart) return dateTime;
  const [hhRaw, mm] = timePart.split(":");
  let hour = Number(hhRaw);
  const suffix = hour >= 12 ? "p" : "a";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${mm}${suffix}`;
}

function formatHighTideLabel(dateTime: string): string {
  const timePart = dateTime.includes("T")
    ? dateTime.split("T")[1]?.slice(0, 5)
    : dateTime.split(" ")[1]?.slice(0, 5);
  if (!timePart) return `High tide ${dateTime}`;
  const [hhRaw, mm] = timePart.split(":");
  let hour = Number(hhRaw);
  const suffix = hour >= 12 ? "p.m." : "a.m.";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `High tide ${hour}:${mm} ${suffix}`;
}

function yyyymmddInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${year}${month}${day}`;
}

function addDaysYyyymmdd(yyyymmdd: string, days: number): string {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

async function fetchWeather(
  config: AppConfig
): Promise<{ line: string; observedAt: string | null }> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(config.marineLatitude));
  url.searchParams.set("longitude", String(config.marineLongitude));
  url.searchParams.set(
    "current",
    "temperature_2m,weather_code,wind_speed_10m,wind_direction_10m"
  );
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("timezone", config.marineTimezone);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo weather failed (${res.status})`);
  }
  const data = (await res.json()) as {
    current?: {
      time?: string;
      temperature_2m?: number;
      weather_code?: number;
      wind_speed_10m?: number;
      wind_direction_10m?: number;
    };
  };
  const current = data.current;
  if (!current || current.temperature_2m == null) {
    throw new Error("Open-Meteo returned no current weather");
  }

  const temp = Math.round(current.temperature_2m);
  const label = WMO_LABELS[current.weather_code ?? -1] ?? "Local conditions";
  const windSpeed = Math.round(current.wind_speed_10m ?? 0);
  const windDir = windDirLabel(current.wind_direction_10m ?? 0);
  const asOfClock = current.time ? formatClock(current.time.replace("T", " ")) : "";
  const line = asOfClock
    ? `${temp}°F · ${label} · Wind ${windDir} ${windSpeed} mph · as of ${asOfClock}`
    : `${temp}°F · ${label} · Wind ${windDir} ${windSpeed} mph`;
  return { line, observedAt: current.time ?? null };
}

type TidePoint = { t: string; v: string; type: string };

async function fetchTidePoints(
  config: AppConfig,
  issueDate?: string
): Promise<TidePoint[]> {
  const base = issueDate
    ? yyyymmddInZone(new Date(`${issueDate}T12:00:00Z`), config.marineTimezone)
    : yyyymmddInZone(new Date(), config.marineTimezone);
  const end = addDaysYyyymmdd(base, 1);

  const url = new URL("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter");
  url.searchParams.set("begin_date", base);
  url.searchParams.set("end_date", end);
  url.searchParams.set("station", config.tideStationId);
  url.searchParams.set("product", "predictions");
  url.searchParams.set("datum", "MLLW");
  url.searchParams.set("time_zone", "lst_ldt");
  url.searchParams.set("units", "english");
  url.searchParams.set("interval", "hilo");
  url.searchParams.set("format", "json");
  url.searchParams.set("application", "ebb-flow-newsletter");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`NOAA tides failed (${res.status})`);
  }
  const data = (await res.json()) as {
    predictions?: TidePoint[];
    error?: { message?: string };
  };
  if (data.error?.message) {
    throw new Error(data.error.message);
  }
  return data.predictions ?? [];
}

function formatTideTimes(points: TidePoint[], type: "H" | "L"): string {
  const ofType = points.filter((p) => p.type === type);
  const day = points[0]?.t?.slice(0, 10);
  const sameDay = day ? ofType.filter((p) => p.t.startsWith(day)) : [];
  const rest = ofType.filter((p) => !sameDay.includes(p));
  const use = [...sameDay, ...rest].slice(0, 2);
  return use.map((p) => formatClock(p.t)).join(" · ");
}

/**
 * Live Ketchikan weather (Open-Meteo) + NOAA high/low tide predictions.
 */
export async function fetchMarineConditions(
  config: AppConfig,
  issueDate?: string
): Promise<MarineConditions> {
  const [weather, tides] = await Promise.all([
    fetchWeather(config),
    fetchTidePoints(config, issueDate),
  ]);

  if (!tides.length) {
    throw new Error("NOAA returned no tide predictions for this station/date");
  }

  const firstHigh = tides.find((p) => p.type === "H");
  return {
    weather: weather.line,
    high_tides: formatTideTimes(tides, "H") || "—",
    low_tides: formatTideTimes(tides, "L") || "—",
    high_tide_label: firstHigh
      ? formatHighTideLabel(firstHigh.t)
      : "High tide —",
    as_of: weather.observedAt ?? new Date().toISOString(),
  };
}
