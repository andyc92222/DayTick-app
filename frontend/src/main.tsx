import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronRight,
  Circle,
  Clock3,
  Leaf,
  ListTodo,
  LogOut,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { api, clock, remaining } from "./api";
import type { Session, Task, Timer } from "./api";
import "./styles.css";

function Logo() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Check size={22} strokeWidth={3} />
      </span>
      <span>
        DayTick<span className="brand-dot">.</span>
      </span>
    </div>
  );
}

function readSession(): Session | null {
  try {
    return JSON.parse(sessionStorage.getItem("daytick-session") || "null");
  } catch {
    return null;
  }
}

function App() {
  const [session, setSession] = useState<Session | null>(readSession);
  const [expired, setExpired] = useState(false);
  const logout = useCallback(() => {
    sessionStorage.removeItem("daytick-session");
    setSession(null);
  }, []);
  useEffect(() => {
    const handler = () => {
      logout();
      setExpired(true);
    };
    window.addEventListener("daytick:expired", handler);
    return () => window.removeEventListener("daytick:expired", handler);
  }, [logout]);
  function signedIn(value: Session) {
    sessionStorage.setItem("daytick-session", JSON.stringify(value));
    setExpired(false);
    setSession(value);
  }
  return session ? (
    <Dashboard key={session.access_token} session={session} logout={logout} />
  ) : (
    <Auth onLogin={signedIn} expired={expired} />
  );
}

function Auth({
  onLogin,
  expired,
}: {
  onLogin: (session: Session) => void;
  expired: boolean;
}) {
  const [register, setRegister] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      onLogin(
        await api<Session>(
          `/auth/${register ? "register" : "login"}`,
          undefined,
          "POST",
          { email: data.get("email"), password: data.get("password") },
        ),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell">
      <section className="auth-story">
        <Logo />
        <div>
          <span className="eyebrow">A LITTLE STRUCTURE. A CALMER DAY.</span>
          <h1>
            Make time for
            <br />
            what matters<span>.</span>
          </h1>
          <p>
            One task. One countdown. A little more space to focus on your day.
          </p>
          <div className="auth-art" aria-hidden="true">
            <div>
              <Leaf size={46} />
              <span>Room to focus.</span>
            </div>
          </div>
        </div>
        <span className="muted">Your day, at your own pace.</span>
      </section>
      <section className="auth-panel">
        <div className="auth-form">
          <span className="eyebrow">YOUR DAILY STARTING POINT</span>
          <h2>{register ? "A fresh start." : "Welcome back."}</h2>
          <p className="muted">
            {register
              ? "Create your own little space for a focused day."
              : "A clear plan for whatever today brings."}
          </p>
          {expired && (
            <p role="status" className="notice">
              Your session expired. Sign in to continue.
            </p>
          )}
          <form onSubmit={submit}>
            <label>
              Email address
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                placeholder="you@example.com"
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                minLength={10}
                maxLength={128}
                autoComplete={register ? "new-password" : "current-password"}
                required
                placeholder="At least 10 characters"
              />
            </label>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy}>
              {busy
                ? "Just a moment…"
                : register
                  ? "Create account"
                  : "Sign in"}
              <ArrowRight size={17} />
            </button>
          </form>
          <p className="auth-switch">
            {register ? "Already have an account?" : "New to DayTick?"}{" "}
            <button
              className="text-button"
              onClick={() => {
                setRegister(!register);
                setError("");
              }}
            >
              {register ? "Sign in" : "Create an account"}
            </button>
          </p>
        </div>
      </section>
    </main>
  );
}

function Dashboard({
  session,
  logout,
}: {
  session: Session;
  logout: () => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [timers, setTimers] = useState<Timer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [carriedTask, setCarriedTask] = useState<Task | null>(null);
  const [zone, setZone] = useState(session.timezone);
  const [tick, setTick] = useState(performance.now());
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Task | "new" | null>(null);
  const refreshSequence = useRef(0);
  const token = session.access_token;
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const [taskResult, timerResult] = await Promise.all([
      api<{ tasks: Task[]; timezone: string }>("/tasks/today", token),
      api<{ timers: Timer[] }>("/timers", token),
    ]);
    if (sequence !== refreshSequence.current) return;
    const sampledAt = performance.now();
    setTasks(taskResult.tasks);
    setZone(taskResult.timezone);
    setTimers(timerResult.timers.map((t) => ({ ...t, sampledAt })));
    const running = timerResult.timers.find((t) => t.status === "running");
    if (running && !taskResult.tasks.some((t) => t.id === running.task_id)) {
      const task = await api<Task>(`/tasks/${running.task_id}`, token);
      if (sequence !== refreshSequence.current) return;
      setCarriedTask(task);
    } else setCarriedTask(null);
    setSelectedId(
      (id) =>
        id ||
        running?.task_id ||
        taskResult.tasks.find((t) => t.status === "active")?.id ||
        null,
    );
    setLoading(false);
  }, [token]);
  useEffect(() => {
    const sync = () => {
      void refresh().catch((err) => {
        setError(err.message);
        setLoading(false);
      });
    };
    sync();
    const poll = window.setInterval(sync, 10000);
    const clockTick = window.setInterval(() => setTick(performance.now()), 250);
    window.addEventListener("focus", sync);
    return () => {
      clearInterval(poll);
      clearInterval(clockTick);
      window.removeEventListener("focus", sync);
    };
  }, [refresh]);
  const visibleTasks = carriedTask ? [carriedTask, ...tasks] : tasks;
  const selected =
    visibleTasks.find((t) => t.id === selectedId) ||
    visibleTasks.find((t) => t.status === "active");
  const timer = timers.find((t) => t.task_id === selected?.id);
  const seconds = timer
    ? remaining(timer, tick)
    : selected?.planned_duration_seconds || 0;
  const expired =
    !!timer &&
    (timer.status === "expired" ||
      (timer.status === "running" && seconds <= 0));
  const running = timer?.status === "running" && !expired;
  const paused = timer?.status === "paused";
  const active = selected?.status === "active";
  const progress = selected
    ? seconds /
      (timer?.planned_duration_seconds || selected.planned_duration_seconds)
    : 1;
  const date = new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: zone,
  }).format(new Date());

  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      await refresh().catch((err) => setError(err.message));
      setBusy(false);
    }
  }
  function timerAction(action: string) {
    if (selected)
      void perform(() =>
        api(`/timers/${selected.id}/${action}`, token, "POST"),
      );
  }
  function complete(task: Task) {
    void perform(() => api(`/tasks/${task.id}/complete`, token, "POST"));
  }
  function remove(task: Task) {
    if (window.confirm(`Delete “${task.title}” and its timer?`))
      void perform(async () => {
        await api(`/tasks/${task.id}`, token, "DELETE");
        if (selectedId === task.id) setSelectedId(null);
      });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <div className="workspace-label">YOUR SPACE</div>
        <div className="nav-item">
          <Sun size={19} />
          <span>Today</span>
          <span className="nav-dot" />
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <Leaf size={23} />
            <p>
              Small steps.
              <br />
              Meaningful progress.
            </p>
          </div>
          <div className="account">
            <span className="avatar">
              {session.user.email[0].toUpperCase()}
            </span>
            <div>
              <strong>Personal workspace</strong>
              <span title={session.user.email}>{session.user.email}</span>
            </div>
            <button
              className="icon-button"
              aria-label="Logout"
              onClick={logout}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <main className="dashboard">
        <header className="topbar">
          <span>
            My workspace <ChevronRight size={14} /> <strong>Today</strong>
          </span>
          <span className="private-label">
            <Circle size={7} fill="currentColor" /> Just for you
          </span>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">LET’S MAKE A LITTLE PROGRESS</span>
              <h1>
                Your day, made clear<span>.</span>
              </h1>
              <p>A little intention goes a long way. Start with one thing.</p>
            </div>
            <span className="date-badge">
              <Sun size={17} />
              {date}
            </span>
          </div>
          {error && (
            <div className="error error-banner" role="alert">
              <span>{error}</span>
              <button
                className="text-button"
                onClick={() => void perform(async () => {})}
              >
                Retry
              </button>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          <div className="workspace-grid">
            <section className="task-panel">
              <div className="section-heading">
                <div>
                  <h2>
                    <ListTodo size={21} /> Today’s tasks
                    <span className="count">{tasks.length}</span>
                  </h2>
                  <p>A short list. A clear head.</p>
                </div>
                <button
                  className="primary small"
                  onClick={() => setEditor("new")}
                  disabled={busy}
                >
                  <Plus size={16} /> Add task
                </button>
              </div>
              <div className="task-list" aria-label="Today's tasks">
                {loading ? (
                  <div className="empty-state">Getting your day ready…</div>
                ) : !visibleTasks.length ? (
                  <div className="empty-state">
                    <span className="empty-icon">
                      <ListTodo size={30} />
                    </span>
                    <h3>A little room for possibility.</h3>
                    <p>Add your first task and give it some time.</p>
                    <button
                      className="text-button"
                      onClick={() => setEditor("new")}
                    >
                      Create a task <ArrowRight size={15} />
                    </button>
                  </div>
                ) : (
                  visibleTasks.map((task) => {
                    const taskTimer = timers.find((t) => t.task_id === task.id);
                    const taskRunning =
                      taskTimer?.status === "running" &&
                      remaining(taskTimer, tick) > 0;
                    const pending = [
                      "updating",
                      "completing",
                      "deleting",
                    ].includes(task.status);
                    return (
                      <article
                        key={task.id}
                        className={`task-row ${selected?.id === task.id ? "selected" : ""} ${task.status === "completed" ? "completed" : ""}`}
                      >
                        <button
                          className={`complete-button ${task.status === "completed" ? "checked" : ""}`}
                          aria-label={`Complete ${task.title}`}
                          disabled={busy || task.status !== "active"}
                          onClick={() => complete(task)}
                        >
                          {task.status === "completed" && <Check size={15} />}
                        </button>
                        <button
                          className="task-select"
                          onClick={() => setSelectedId(task.id)}
                          aria-pressed={selected?.id === task.id}
                        >
                          <strong>{task.title}</strong>
                          <span>
                            <Clock3 size={12} />
                            {task.planned_duration_seconds / 60} min
                            {taskRunning && (
                              <em className="running-tag">In progress</em>
                            )}
                            {task.status === "completed" && <em>Completed</em>}
                            {carriedTask?.id === task.id && (
                              <em>From an earlier day</em>
                            )}
                            {pending && <em>Change pending</em>}
                          </span>
                        </button>
                        {pending ? (
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => {
                              if (task.status === "completing") complete(task);
                              else if (task.status === "deleting") remove(task);
                              else
                                void perform(() =>
                                  api(`/tasks/${task.id}`, token, "PATCH", {
                                    planned_duration_seconds:
                                      task.pending_duration_seconds,
                                  }),
                                );
                            }}
                          >
                            Retry
                          </button>
                        ) : (
                          <div className="task-actions">
                            {task.status === "active" && (
                              <button
                                className="icon-button"
                                aria-label={`Edit ${task.title}`}
                                onClick={() => setEditor(task)}
                                disabled={busy}
                              >
                                <Pencil size={15} />
                              </button>
                            )}
                            <button
                              className="icon-button delete-button"
                              aria-label={`Delete ${task.title}`}
                              disabled={busy}
                              onClick={() => remove(task)}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        )}
                      </article>
                    );
                  })
                )}
              </div>
              <div className="list-footer">
                <CheckCheck size={16} /> One thing at a time is more than
                enough.
              </div>
            </section>
            <section className="timer-panel" aria-label="Countdown timer">
              <div className="timer-top">
                <span className="eyebrow">YOUR FOCUS SPACE</span>
                <MoreHorizontal size={19} />
              </div>
              <h2>{selected ? selected.title : "A moment to begin."}</h2>
              <p>
                {selected
                  ? "Give this one thing your attention."
                  : "Choose a task to start your countdown."}
              </p>
              <div className={`countdown ${expired ? "time-up" : ""}`}>
                <svg viewBox="0 0 240 240" aria-hidden="true">
                  <circle className="track" cx="120" cy="120" r="109" />
                  <circle
                    className="progress"
                    cx="120"
                    cy="120"
                    r="109"
                    strokeDasharray={2 * Math.PI * 109}
                    strokeDashoffset={
                      2 *
                      Math.PI *
                      109 *
                      (1 - Math.min(1, Math.max(0, progress)))
                    }
                  />
                </svg>
                <div>
                  <span className="timer-state">
                    {expired
                      ? "TIME UP"
                      : running
                        ? "IN THE MOMENT"
                        : paused
                          ? "TAKE A BREATH"
                          : "READY WHEN YOU ARE"}
                  </span>
                  <strong
                    className="time"
                    role="timer"
                    aria-label="Time remaining"
                  >
                    {clock(seconds)}
                  </strong>
                  <span className="timer-caption" role="status">
                    {expired
                      ? "Time Up"
                      : running
                        ? "A little closer, every second"
                        : paused
                          ? "Your time is saved"
                          : "Make a little room for focus"}
                  </span>
                </div>
              </div>
              <div className="timer-controls">
                <button
                  className="primary"
                  disabled={!selected || !active || busy || expired}
                  onClick={() =>
                    timerAction(running ? "pause" : paused ? "resume" : "start")
                  }
                >
                  {running ? (
                    <Pause size={17} fill="currentColor" />
                  ) : (
                    <Play size={17} fill="currentColor" />
                  )}
                  {running ? "Pause" : paused ? "Resume" : "Start countdown"}
                </button>
                <button
                  className="reset-button"
                  aria-label="Reset countdown"
                  disabled={!selected || !active || busy}
                  onClick={() => timerAction("reset")}
                >
                  <RotateCcw size={19} />
                </button>
              </div>
              <button
                className="finish-button"
                disabled={!selected || !active || busy}
                onClick={() => selected && complete(selected)}
              >
                <Check size={16} /> Mark as completed
              </button>
              <div className="timer-footnote">
                <span className={`status-dot ${running ? "pulsing" : ""}`} />
                {running
                  ? "Countdown saved. You can safely refresh."
                  : "Your pace. Your progress."}
              </div>
            </section>
          </div>
          <footer className="page-footer">
            <Leaf size={16} />
            <span>You don’t have to do it all. Just the next thing.</span>
            <span className="timezone">{zone}</span>
          </footer>
        </div>
      </main>
      {editor && (
        <TaskForm
          task={editor === "new" ? null : editor}
          token={token}
          onClose={() => setEditor(null)}
          onSave={async (task) => {
            setSelectedId(task.id);
            setEditor(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function TaskForm({
  task,
  token,
  onClose,
  onSave,
}: {
  task: Task | null;
  token: string;
  onClose: () => void;
  onSave: (task: Task) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const saved = await api<Task>(
        task ? `/tasks/${task.id}` : "/tasks",
        token,
        task ? "PATCH" : "POST",
        {
          title: data.get("title"),
          planned_duration_seconds: Math.round(
            Number(data.get("duration")) * 60,
          ),
        },
      );
      await onSave(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      aria-labelledby="form-title"
    >
      <div className="dialog-heading">
        <h2 id="form-title">{task ? "Edit task" : "Make a little plan."}</h2>
        <button
          className="icon-button"
          aria-label="Close form"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <p className="muted">What would you like to make time for?</p>
      <form onSubmit={submit}>
        <label>
          Task title
          <input
            name="title"
            required
            maxLength={200}
            autoFocus
            placeholder="Something that matters to you"
            defaultValue={task?.title || ""}
          />
        </label>
        <label>
          Planned duration (minutes)
          <input
            name="duration"
            type="number"
            required
            min={1 / 60}
            max={1440}
            step="any"
            defaultValue={task ? task.planned_duration_seconds / 60 : 25}
          />
        </label>
        <p className="field-hint">
          Up to 24 hours. Reset a started timer before changing its duration.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : task ? "Save changes" : "Create task"}
            <Plus size={16} />
          </button>
        </div>
      </form>
    </dialog>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
