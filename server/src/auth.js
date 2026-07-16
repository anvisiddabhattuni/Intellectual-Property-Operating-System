import jwt from 'jsonwebtoken';
import { tenantContext } from './db/context.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRY = '8h';

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenant_id },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

// Verifies the JWT and attaches the claims to req.user.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // Run the rest of the request inside this user's tenant context so every
  // db query is RLS-scoped to their tenant (STORY-010). Nested next() calls
  // (requireRole, the route handler, its async queries) stay in scope.
  tenantContext.run({ tenantId: req.user.tenantId }, next);
}

// Role-based access control: allow only the listed roles.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    }
    next();
  };
}
