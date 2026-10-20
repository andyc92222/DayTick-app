export type Task = {
  id: string;
  title: string;
  planned_duration_seconds: number;
  status: "active" | "completed" | "updating" | "completing" | "deleting";
  pending_duration_seconds: number | null;
  created_at: string;
};
export type Timer = {
  task_id: string;
  status: "idle" | "running" | "paused" | "expired";
  planned_duration_seconds: number;
  remaining_seconds: number;
  ends_at: string | null;
  server_time: string;
  sampledAt: number;
};
export type Session = {
  access_token: string;
  user: { id: string; email: string };
  timezone: string;
};

export async function api<T>(
  path: string,
  token?: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw new Error(
      "Cannot reach DayTick. Check your connection and try again.",
    );
  }
  if (!response.ok) {
    if (response.status === 401 && token)
      window.dispatchEvent(new Event("daytick:expired"));
    const error = await response.json().catch(() => null);
    throw new Error(
      typeof error?.detail === "string"
        ? error.detail
        : response.status >= 500
          ? "A service is unavailable. Please retry shortly."
          : "Please check your input.",
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export function remaining(timer: Timer, at = performance.now()): number {
  return Math.max(
    0,
    timer.remaining_seconds -
      (timer.status === "running" ? (at - timer.sampledAt) / 1000 : 0),
  );
}

export function clock(seconds: number) {
  const total = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}`
    : `${String(minutes).padStart(2, "0")}:${secs}`;
}
