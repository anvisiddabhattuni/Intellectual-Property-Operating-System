import { useEffect, useState } from 'react';
import {
  AppBar, Toolbar, Typography, Button, Box, Card, CardContent, Grid, Alert, Chip,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper
} from '@mui/material';
import { api } from './api.js';

const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

export default function Dashboard({ session, onLogout }) {
  const [data, setData] = useState(null);
  const [auditRows, setAuditRows] = useState(null);
  const [error, setError] = useState(null);
  const isAdmin = ['tenant_admin', 'super_admin'].includes(session.user.role);

  useEffect(() => {
    api('/api/sales', { token: session.token })
      .then(setData)
      .catch((e) => setError(e.message));
    if (isAdmin) {
      api('/api/audit', { token: session.token })
        .then((d) => setAuditRows(d.audit))
        .catch(() => setAuditRows(null));
    }
  }, [session, isAdmin]);

  const grand = data?.totals?.reduce(
    (acc, t) => ({
      units: acc.units + Number(t.units),
      revenue: acc.revenue + Number(t.revenue),
      royalty: acc.royalty + Number(t.royalty)
    }),
    { units: 0, revenue: 0, royalty: 0 }
  );

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: '#f5f6f8' }}>
      <AppBar position="static">
        <Toolbar>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>IPOS — Revenue Dashboard</Typography>
          <Chip label={session.user.role} color="secondary" size="small" sx={{ mr: 2 }} />
          <Typography variant="body2" sx={{ mr: 2 }}>{session.user.name}</Typography>
          <Button color="inherit" onClick={onLogout}>Sign out</Button>
        </Toolbar>
      </AppBar>

      <Box sx={{ p: 3, maxWidth: 1100, mx: 'auto' }}>
        {error && <Alert severity="error">{error}</Alert>}

        {data && (
          <>
            <Grid container spacing={2} sx={{ mb: 3 }}>
              <Grid item xs={12} sm={4}>
                <Card><CardContent>
                  <Typography color="text.secondary" variant="body2">Units sold (30 days)</Typography>
                  <Typography variant="h4">{grand.units.toLocaleString()}</Typography>
                </CardContent></Card>
              </Grid>
              <Grid item xs={12} sm={4}>
                <Card><CardContent>
                  <Typography color="text.secondary" variant="body2">Gross revenue</Typography>
                  <Typography variant="h4">{money(grand.revenue)}</Typography>
                </CardContent></Card>
              </Grid>
              <Grid item xs={12} sm={4}>
                <Card><CardContent>
                  <Typography color="text.secondary" variant="body2">Royalties earned</Typography>
                  <Typography variant="h4">{money(grand.royalty)}</Typography>
                </CardContent></Card>
              </Grid>
            </Grid>

            <Typography variant="h6" sx={{ mb: 1 }}>By platform</Typography>
            <TableContainer component={Paper} sx={{ mb: 4 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Platform</TableCell>
                    <TableCell align="right">Units</TableCell>
                    <TableCell align="right">Revenue</TableCell>
                    <TableCell align="right">Royalty</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.totals.map((t) => (
                    <TableRow key={t.platform}>
                      <TableCell>{t.platform}</TableCell>
                      <TableCell align="right">{t.units}</TableCell>
                      <TableCell align="right">{money(t.revenue)}</TableCell>
                      <TableCell align="right">{money(t.royalty)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>

            <Typography variant="h6" sx={{ mb: 1 }}>
              Recent sales — Trust Before Intelligence
            </Typography>
            <TableContainer component={Paper} sx={{ maxHeight: 360, mb: 4 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>Date</TableCell>
                    <TableCell>Platform</TableCell>
                    <TableCell align="right">Units</TableCell>
                    <TableCell align="right">Revenue</TableCell>
                    <TableCell align="right">Royalty</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.sales.slice(0, 30).map((s, i) => (
                    <TableRow key={i}>
                      <TableCell>{s.sale_date.slice(0, 10)}</TableCell>
                      <TableCell>{s.platform}</TableCell>
                      <TableCell align="right">{s.units}</TableCell>
                      <TableCell align="right">{money(s.revenue)}</TableCell>
                      <TableCell align="right">{money(s.royalty)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}

        {isAdmin && auditRows && (
          <>
            <Typography variant="h6" sx={{ mb: 1 }}>Audit log (admin only, append-only)</Typography>
            <TableContainer component={Paper} sx={{ maxHeight: 300 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>When</TableCell>
                    <TableCell>Actor</TableCell>
                    <TableCell>Action</TableCell>
                    <TableCell>Detail</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {auditRows.map((a, i) => (
                    <TableRow key={i}>
                      <TableCell>{new Date(a.created_at).toLocaleString()}</TableCell>
                      <TableCell>{a.actor}</TableCell>
                      <TableCell>{a.action}</TableCell>
                      <TableCell><code>{JSON.stringify(a.detail)}</code></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}
      </Box>
    </Box>
  );
}
