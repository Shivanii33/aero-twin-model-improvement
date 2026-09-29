import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { Eye, EyeOff, PlaneTakeoff } from "lucide-react";
import { DEMO_ACCOUNTS_DISPLAY, DemoAuthContext, authenticateDemo, clearDemoUser, initials, readDemoUser, saveDemoUser, type DemoUser } from "@/lib/demoAuth";

function LoginScreen({ onLogin }: { onLogin: (user: DemoUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const submitRef = useRef<HTMLButtonElement>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const user = authenticateDemo(username, password);
    if (!user) {
      setError("Incorrect username or password.");
      setPassword("");
      return;
    }
    setError("");
    onLogin(user);
  }

  function continueAs(account: (typeof DEMO_ACCOUNTS_DISPLAY)[number]) {
    setUsername(account.username);
    setPassword(account.password);
    setError("");
    submitRef.current?.focus();
  }

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit} noValidate>
        <div className="auth-brand">
          <span className="auth-logo" aria-hidden="true">
            <PlaneTakeoff size={20} />
          </span>
          <strong>AeroTwin</strong>
        </div>

        <h1>Ground Control sign in</h1>
        <p className="auth-note">Sign in to access the AeroTwin dashboard.</p>

        <label htmlFor="auth-username">Username</label>
        <input
          id="auth-username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={username}
          onChange={e => setUsername(e.target.value)}
        />

        <label htmlFor="auth-password">Password</label>
        <div className="auth-password">
          <input
            id="auth-password"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            required
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
          <button
            type="button"
            className="auth-toggle"
            onClick={() => setShow(v => !v)}
            aria-label={show ? "Hide password" : "Show password"}
            aria-pressed={show}
          >
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>

        {error && <p role="alert" className="auth-error">{error}</p>}

        <button ref={submitRef} type="submit" className="auth-submit">
          Sign in
        </button>

        <section className="auth-demo" aria-label="Demo accounts">
          <h2>Demo accounts</h2>

          <ul>
            {DEMO_ACCOUNTS_DISPLAY.map(account => (
              <li key={account.username}>
                <span className="auth-avatar" aria-hidden="true">
                  {initials(account.displayName)}
                </span>
                <span>
                  <b>{account.username} / {account.password}</b>
                  <small>{account.role}</small>
                </span>
              </li>
            ))}
          </ul>

          <div className="auth-quick">
            {DEMO_ACCOUNTS_DISPLAY.map(account => (
              <button
                key={account.username}
                type="button"
                onClick={() => continueAs(account)}
              >
                Continue as {account.role === "Operator" ? "Operator" : "Engineer"}
              </button>
            ))}
          </div>

          <p className="auth-note">
            Operator = flight view and mission decisions. Engineer = diagnostics,
            model evidence and fault records.
          </p>
        </section>
      </form>
    </main>
  );
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<DemoUser | null>(() => readDemoUser());

  if (!user) {
    return (
      <LoginScreen
        onLogin={next => {
          saveDemoUser(next);
          setUser(next);
        }}
      />
    );
  }

  const signOut = () => {
    clearDemoUser();
    setUser(null);
  };

  return (
    <DemoAuthContext.Provider value={{ user, signOut }}>
      {children}
    </DemoAuthContext.Provider>
  );
}
