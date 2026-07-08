import { useState } from 'react';
import { Box, Paper, TextField, Button, Typography, Alert } from '@mui/material';
import { api } from './api.js';

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('ram@ipos.demo');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await api('/api/auth/login', { method: 'POST', body: { email, password } });
      onLogin(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', bgcolor: '#f5f6f8' }}>
      <Paper sx={{ p: 4, width: 380 }} component="form" onSubmit={submit}>
        <Typography variant="h5" gutterBottom>IPOS</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Intellectual Property Operating System — sign in
        </Typography>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <TextField label="Email" fullWidth sx={{ mb: 2 }} value={email}
          onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        <TextField label="Password" type="password" fullWidth sx={{ mb: 3 }} value={password}
          onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        <Button type="submit" variant="contained" fullWidth disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
          Demo: ram@ipos.demo / author123 · admin@ipos.demo / admin123
        </Typography>
      </Paper>
    </Box>
  );
}
