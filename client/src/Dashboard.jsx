import { useEffect, useState } from 'react';
import {
  AppBar, Toolbar, Typography, Button, Box, Card, CardContent, Grid, Alert, Chip,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper
} from '@mui/material';
import { api } from './api.js';
import ForecastChart from './ForecastChart.jsx';

const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

const ago = (ts) => {
  const mins = Math.round((Date.now() - new Date(ts)) / 60000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} h ago` : `${Math.round(hrs / 24)} d ago`;
};

export default function Dashboard({ session, onLogout }) {
  const [data, setData] = useState(null);
  const [auditRows, setAuditRows] = useState(null);
  const [refresh, setRefresh] = useState(null);
  const [statements, setStatements] = useState(null);
  const [payouts, setPayouts] = useState(null);
  const [forecasts, setForecasts] = useState(null);
  const [anomalies, setAnomalies] = useState(null);
  const [marketing, setMarketing] = useState(null);
  const [ingest, setIngest] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const isAdmin = ['tenant_admin', 'super_admin'].includes(session.user.role);

  const load = () => {
    api('/api/sales', { token: session.token })
      .then(setData)
      .catch((e) => setError(e.message));
    api('/api/refresh/status', { token: session.token })
      .then(setRefresh)
      .catch(() => setRefresh(null));
    api('/api/royalties', { token: session.token })
      .then((d) => setStatements(d.statements))
      .catch(() => setStatements(null));
    api('/api/payouts', { token: session.token })
      .then(setPayouts)
      .catch(() => setPayouts(null));
    api('/api/forecasts', { token: session.token })
      .then((d) => setForecasts(d.forecasts))
      .catch(() => setForecasts(null));
    api('/api/marketing', { token: session.token })
      .then((d) => setMarketing(d.recommendations))
      .catch(() => setMarketing(null));
    if (isAdmin) {
      api('/api/audit', { token: session.token })
        .then((d) => setAuditRows(d.audit))
        .catch(() => setAuditRows(null));
      api('/api/anomalies', { token: session.token })
        .then((d) => setAnomalies(d.anomalies))
        .catch(() => setAnomalies(null));
    }
  };
  useEffect(load, [session, isAdmin]);

  // POST an action (payout initiate/approve/reject), then reload everything.
  const act = async (path, body = {}) => {
    setBusy(true);
    try {
      await api(path, { method: 'POST', token: session.token, body });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      load();
    }
  };

  const triggerRefresh = async (simulateFailure = []) => {
    setBusy(true);
    try {
      await api('/api/refresh', { method: 'POST', token: session.token, body: { simulateFailure } });
    } catch {
      // failed runs are expected when simulating; status panel shows the result
    } finally {
      setBusy(false);
      load();
    }
  };

  // Upload a platform's exported sales report (STORY-001/002/003).
  const uploadReport = async (slug, file) => {
    if (!file) return;
    setBusy(true);
    try {
      const csv = await file.text();
      const r = await api(`/api/integrations/${slug}/upload`, { method: 'POST', token: session.token, body: { csv } });
      setIngest((prev) => ({ ...prev, [slug]: r.summary }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      load();
    }
  };

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

        {refresh && (
          <Alert
            severity={refresh.staleHours == null ? 'warning' : refresh.staleHours < 24 ? 'success' : 'warning'}
            sx={{ mb: 2 }}
          >
            {refresh.lastSuccessfulRefresh
              ? `Data last refreshed ${ago(refresh.lastSuccessfulRefresh)} (target: every 24 h)`
              : 'No successful data refresh recorded yet'}
          </Alert>
        )}

        {isAdmin && refresh?.openAlerts?.length > 0 && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {refresh.openAlerts.length} open alert{refresh.openAlerts.length > 1 ? 's' : ''}:{' '}
            {refresh.openAlerts[0].message}
          </Alert>
        )}

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

        {statements?.length > 0 && (
          <>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Royalty statements (calculated from contract terms)
            </Typography>
            {[...new Set(statements.map((s) => s.period_start))].map((period) => {
              const monthLines = statements.filter((s) => s.period_start === period);
              const titles = [...new Set(monthLines.map((s) => s.title))];
              return (
                <TableContainer component={Paper} key={period} sx={{ mb: 2 }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ fontWeight: 'bold' }}>
                          {new Date(period).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}
                        </TableCell>
                        <TableCell align="right">Units</TableCell>
                        <TableCell align="right">Revenue</TableCell>
                        <TableCell align="right">Contract rate</TableCell>
                        <TableCell align="right">Royalty owed</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {titles.map((title) => {
                        const lines = monthLines.filter((s) => s.title === title);
                        const tot = lines.reduce((a, l) => ({
                          units: a.units + l.units,
                          revenue: a.revenue + Number(l.revenue),
                          royalty: a.royalty + Number(l.royalty_amount || 0)
                        }), { units: 0, revenue: 0, royalty: 0 });
                        return [
                          ...lines.map((l) => (
                            <TableRow key={l.platform}>
                              <TableCell sx={{ pl: 4 }}>{title} — {l.platform}</TableCell>
                              <TableCell align="right">{l.units}</TableCell>
                              <TableCell align="right">{money(l.revenue)}</TableCell>
                              <TableCell align="right">
                                {l.missing_contract
                                  ? <Chip size="small" color="error" label="no contract" />
                                  : `${(l.royalty_rate * 100).toFixed(0)}%`}
                              </TableCell>
                              <TableCell align="right">{l.missing_contract ? '—' : money(l.royalty_amount)}</TableCell>
                            </TableRow>
                          )),
                          <TableRow key={`${title}-total`} sx={{ '& td': { fontWeight: 'bold' } }}>
                            <TableCell>{title} — total</TableCell>
                            <TableCell align="right">{tot.units}</TableCell>
                            <TableCell align="right">{money(tot.revenue)}</TableCell>
                            <TableCell align="right" />
                            <TableCell align="right">{money(tot.royalty)}</TableCell>
                          </TableRow>
                        ];
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              );
            })}
            <Box sx={{ mb: 4 }} />
          </>
        )}

        {forecasts && data && (() => {
          // Daily revenue across platforms feeds the chart's "actual" line.
          const byDay = {};
          for (const s of data.sales) {
            const d = s.sale_date.slice(0, 10);
            byDay[d] = (byDay[d] || 0) + Number(s.revenue);
          }
          const historyAll = Object.entries(byDay)
            .map(([date, revenue]) => ({ date, revenue }))
            .sort((a, b) => a.date.localeCompare(b.date));
          const history = historyAll.slice(-60);
          const approved = forecasts.find((f) => f.status === 'approved');
          const pending = forecasts.filter((f) => f.status === 'pending_review');
          const shown = approved || (isAdmin && pending[0]) || null;
          return (
            <>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
                <Typography variant="h6">Revenue forecast (AI Insights Agent)</Typography>
                {isAdmin && (
                  <Button size="small" variant="contained" disabled={busy}
                    onClick={() => act('/api/forecasts', { horizonDays: 30 })}>
                    Generate forecast
                  </Button>
                )}
              </Box>
              {shown ? (
                <Paper sx={{ mb: 1, p: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, px: 1.5, pt: 1, flexWrap: 'wrap' }}>
                    <Typography variant="h5">{money(shown.total)}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      next {shown.horizon_days} days · 95% interval {money(shown.total_lower)} – {money(shown.total_upper)}
                    </Typography>
                    <Chip size="small"
                      label={shown.status === 'approved' ? `approved by ${shown.reviewed_by}` : 'pending review'}
                      color={shown.status === 'approved' ? 'success' : 'warning'} />
                    {shown.status === 'pending_review' && isAdmin && (
                      <>
                        <Button size="small" color="success" disabled={busy}
                          onClick={() => act(`/api/forecasts/${shown.id}/approve`)}>Approve</Button>
                        <Button size="small" color="error" disabled={busy}
                          onClick={() => act(`/api/forecasts/${shown.id}/reject`)}>Reject</Button>
                      </>
                    )}
                  </Box>
                  <ForecastChart history={history} points={shown.points} />
                </Paper>
              ) : (
                <Alert severity="info" sx={{ mb: 2 }}>
                  No approved forecast yet{isAdmin ? ' — generate one, then approve it.' : ' — check back soon.'}
                </Alert>
              )}
              <Box sx={{ mb: 4 }} />
            </>
          );
        })()}

        {marketing && (() => {
          const approved = marketing.find((m) => m.status === 'approved');
          const pending = marketing.filter((m) => m.status === 'pending_review');
          const shown = approved || (isAdmin && pending[0]) || null;
          return (
            <>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
                <Typography variant="h6">Marketing recommendations (AI Insights Agent)</Typography>
                {isAdmin && (
                  <Button size="small" variant="contained" disabled={busy}
                    onClick={() => act('/api/marketing')}>
                    Generate
                  </Button>
                )}
              </Box>
              {shown ? (
                <Paper sx={{ mb: 4, p: 2 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
                    <Chip size="small"
                      label={shown.status === 'approved' ? `approved by ${shown.reviewed_by}` : 'pending review'}
                      color={shown.status === 'approved' ? 'success' : 'warning'} />
                    <Chip size="small" variant="outlined" label={shown.provider} />
                    <Typography variant="body2" color="text.secondary">
                      relevance ≥ 80% enforced{shown.filtered_out > 0 ? ` · ${shown.filtered_out} below-bar suggestion(s) filtered out` : ''}
                    </Typography>
                    {shown.status === 'pending_review' && isAdmin && (
                      <>
                        <Button size="small" color="success" disabled={busy}
                          onClick={() => act(`/api/marketing/${shown.id}/approve`)}>Approve</Button>
                        <Button size="small" color="error" disabled={busy}
                          onClick={() => act(`/api/marketing/${shown.id}/reject`)}>Reject</Button>
                      </>
                    )}
                  </Box>
                  <Grid container spacing={2}>
                    {shown.recommendations.map((r, i) => (
                      <Grid item xs={12} md={6} key={i}>
                        <Card variant="outlined" sx={{ height: '100%' }}>
                          <CardContent>
                            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 1 }}>
                              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{r.title}</Typography>
                              <Chip size="small" label={`${r.relevance}%`} color="primary" variant="outlined" />
                            </Box>
                            <Typography variant="body2" sx={{ mt: 1 }}>{r.action}</Typography>
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                              Evidence: {r.evidence.join(' · ')}
                            </Typography>
                          </CardContent>
                        </Card>
                      </Grid>
                    ))}
                  </Grid>
                </Paper>
              ) : (
                <Alert severity="info" sx={{ mb: 4 }}>
                  No approved recommendations yet{isAdmin ? ' — generate a set, then approve it.' : ' — check back soon.'}
                </Alert>
              )}
            </>
          );
        })()}

        {payouts && (
          <>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Payouts
              <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 1 }}>
                approval required above {money(payouts.threshold)}
              </Typography>
            </Typography>
            <TableContainer component={Paper} sx={{ mb: 2 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Period</TableCell>
                    <TableCell align="right">Amount</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Requested by</TableCell>
                    <TableCell>Decided by</TableCell>
                    <TableCell>Reference</TableCell>
                    {isAdmin && <TableCell align="right">Action</TableCell>}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {payouts.payouts.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>{String(p.period_start).slice(0, 7)}</TableCell>
                      <TableCell align="right">{money(p.amount)}</TableCell>
                      <TableCell>
                        <Chip size="small" label={p.status.replace('_', ' ')}
                          color={p.status === 'paid' ? 'success'
                            : p.status === 'pending_approval' ? 'warning'
                            : p.status === 'rejected' ? 'default' : 'error'} />
                        {p.detail?.provider === 'simulated' && p.status === 'paid' &&
                          <Chip size="small" variant="outlined" label="simulated" sx={{ ml: 0.5 }} />}
                      </TableCell>
                      <TableCell>{p.requested_by}</TableCell>
                      <TableCell>{p.decided_by || '—'}</TableCell>
                      <TableCell><code>{p.provider_ref || '—'}</code></TableCell>
                      {isAdmin && (
                        <TableCell align="right">
                          {p.status === 'pending_approval' && (
                            <>
                              <Button size="small" color="success" disabled={busy}
                                onClick={() => act(`/api/payouts/${p.id}/approve`)}>Approve</Button>
                              <Button size="small" color="error" disabled={busy}
                                onClick={() => act(`/api/payouts/${p.id}/reject`)}>Reject</Button>
                            </>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            {isAdmin && statements && (
              <Box sx={{ mb: 4 }}>
                {[...new Set(statements.filter((s) => !s.missing_contract).map((s) => String(s.period_start).slice(0, 10)))]
                  .filter((period) => !payouts.payouts.some(
                    (p) => String(p.period_start).slice(0, 7) === period.slice(0, 7)
                      && ['pending_approval', 'paid'].includes(p.status)))
                  .map((period) => (
                    <Button key={period} size="small" variant="outlined" disabled={busy} sx={{ mr: 1 }}
                      onClick={() => act('/api/payouts', { periodStart: period })}>
                      Initiate payout — {period.slice(0, 7)}
                    </Button>
                  ))}
              </Box>
            )}
          </>
        )}

        {isAdmin && anomalies && (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
              <Typography variant="h6">Anomalies (AI Insights Agent — human review required)</Typography>
              <Button size="small" variant="contained" disabled={busy}
                onClick={() => act('/api/anomalies/detect')}>
                Scan now
              </Button>
            </Box>
            {anomalies.length === 0 ? (
              <Alert severity="success" sx={{ mb: 4 }}>No anomalies detected.</Alert>
            ) : (
              <TableContainer component={Paper} sx={{ maxHeight: 320, mb: 4 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      <TableCell>Day</TableCell>
                      <TableCell>What</TableCell>
                      <TableCell align="right">Observed</TableCell>
                      <TableCell>Expected</TableCell>
                      <TableCell>Severity</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell align="right">Action</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {anomalies.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>{String(a.day).slice(0, 10)}</TableCell>
                        <TableCell>
                          {a.method === 'royalty-gap-v1'
                            ? `${a.platform}: reported royalty ≠ contract`
                            : 'daily revenue outlier'}
                        </TableCell>
                        <TableCell align="right">{money(a.observed)}</TableCell>
                        <TableCell>
                          {a.method === 'royalty-gap-v1'
                            ? `${money(a.expected.calculatedFromContract)} per contract (${a.expected.relativeGap})`
                            : `median ${money(a.expected.median)} (z=${a.expected.zScore})`}
                        </TableCell>
                        <TableCell>
                          <Chip size="small" label={a.severity}
                            color={a.severity === 'critical' ? 'error' : 'warning'} />
                        </TableCell>
                        <TableCell>{a.status}</TableCell>
                        <TableCell align="right">
                          {a.status === 'open' && (
                            <>
                              <Button size="small" disabled={busy}
                                onClick={() => act(`/api/anomalies/${a.id}/reviewed`)}>Reviewed</Button>
                              <Button size="small" color="inherit" disabled={busy}
                                onClick={() => act(`/api/anomalies/${a.id}/dismissed`)}>Dismiss</Button>
                            </>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </>
        )}

        {isAdmin && (
          <>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Platform integrations (admin only)
              <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 1 }}>
                upload an exported sales report — parsed, integrity-checked, and added to the dashboard
              </Typography>
            </Typography>
            <TableContainer component={Paper} sx={{ mb: 4 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Platform</TableCell>
                    <TableCell>Report (CSV)</TableCell>
                    <TableCell>Last ingest result</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {[
                    { slug: 'amazon-kdp', name: 'Amazon KDP', story: 'STORY-001' },
                    { slug: 'barnes-noble', name: 'Barnes & Noble', story: 'STORY-002' },
                    { slug: 'kobo', name: 'Kobo', story: 'STORY-003' }
                  ].map((p) => {
                    const s = ingest[p.slug];
                    return (
                      <TableRow key={p.slug}>
                        <TableCell>
                          {p.name}
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{p.story}</Typography>
                        </TableCell>
                        <TableCell>
                          <Button size="small" variant="outlined" component="label" disabled={busy}>
                            Upload report
                            <input type="file" accept=".csv,text/csv" hidden
                              onChange={(e) => { uploadReport(p.slug, e.target.files[0]); e.target.value = ''; }} />
                          </Button>
                        </TableCell>
                        <TableCell>
                          {s ? (
                            <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
                              <Chip size="small" color="success" label={`${s.rowsAccepted} imported`} />
                              {s.rowsRejected > 0 &&
                                <Chip size="small" color="error" label={`${s.rowsRejected} rejected`} />}
                              <Typography variant="caption" color="text.secondary">
                                {s.daysUpserted} day(s) · {s.titles.join(', ')}
                              </Typography>
                            </Box>
                          ) : <Typography variant="caption" color="text.secondary">—</Typography>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}

        {isAdmin && refresh && (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
              <Typography variant="h6">Data operations (admin only)</Typography>
              <Button size="small" variant="contained" disabled={busy}
                onClick={() => triggerRefresh()}>
                Refresh now
              </Button>
              <Button size="small" variant="outlined" color="error" disabled={busy}
                onClick={() => triggerRefresh(['Kobo'])}>
                Simulate Kobo failure
              </Button>
            </Box>
            <TableContainer component={Paper} sx={{ maxHeight: 260, mb: 4 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>Started</TableCell>
                    <TableCell>Trigger</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Platforms</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {refresh.runs.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{new Date(r.started_at).toLocaleString()}</TableCell>
                      <TableCell>{r.trigger}</TableCell>
                      <TableCell>
                        <Chip size="small" label={r.status}
                          color={r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'error' : 'default'} />
                      </TableCell>
                      <TableCell>
                        {(r.detail?.results || []).map((p) =>
                          p.ok ? `${p.platform} ✓` : `${p.platform} ✗`
                        ).join(' · ')}
                      </TableCell>
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
