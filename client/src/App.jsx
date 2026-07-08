import { useState } from 'react';
import Login from './Login.jsx';
import Dashboard from './Dashboard.jsx';

export default function App() {
  const [session, setSession] = useState(() => {
    const saved = sessionStorage.getItem('ipos_session');
    return saved ? JSON.parse(saved) : null;
  });

  const login = (s) => {
    sessionStorage.setItem('ipos_session', JSON.stringify(s));
    setSession(s);
  };
  const logout = () => {
    sessionStorage.removeItem('ipos_session');
    setSession(null);
  };

  return session
    ? <Dashboard session={session} onLogout={logout} />
    : <Login onLogin={login} />;
}
