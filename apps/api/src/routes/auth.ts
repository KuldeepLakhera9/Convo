import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { eq, and } from 'drizzle-orm';
import { db, users, refreshTokens } from '../db';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  RefreshTokenPayload,
} from '../utils/auth';
import jwt from 'jsonwebtoken';

const router = Router();

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
};

// REGISTER
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase()),
    });

    if (existingUser) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const [newUser] = await db
      .insert(users)
      .values({
        email: email.toLowerCase(),
        passwordHash,
      })
      .returning();

    return res.status(201).json({
      user: {
        id: newUser.id,
        email: newUser.email,
        createdAt: newUser.createdAt,
      },
    });
  } catch (error: any) {
    console.error('Registration error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// LOGIN
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase()),
    });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate new refresh token row in database
    const newRefreshTokenId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const refreshToken = generateRefreshToken(user.id, newRefreshTokenId);

    await db.insert(refreshTokens).values({
      id: newRefreshTokenId,
      token: refreshToken,
      userId: user.id,
      expiresAt,
    });

    const accessToken = generateAccessToken(user.id);

    res.cookie('refreshToken', refreshToken, COOKIE_OPTIONS);

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
      },
      accessToken,
    });
  } catch (error: any) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// REFRESH TOKEN (Rotation + Reuse Detection)
router.post('/refresh', async (req: Request, res: Response) => {
  const token = req.cookies.refreshToken;
  if (!token) {
    return res.status(401).json({ error: 'No refresh token provided' });
  }

  let decoded: RefreshTokenPayload;
  try {
    decoded = verifyRefreshToken(token);
  } catch (err: any) {
    // If expired, try to decode to get token details and cleanup
    try {
      const expiredDecoded = jwt.decode(token) as RefreshTokenPayload;
      if (expiredDecoded?.tokenId) {
        await db.delete(refreshTokens).where(eq(refreshTokens.id, expiredDecoded.tokenId));
      }
    } catch (_) {}
    res.clearCookie('refreshToken', COOKIE_OPTIONS);
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  try {
    // Look up token in database
    const tokenRecord = await db.query.refreshTokens.findFirst({
      where: eq(refreshTokens.id, decoded.tokenId),
    });

    // 1. REUSE DETECTION: Token not found or marked revoked
    if (!tokenRecord || tokenRecord.isRevoked) {
      console.warn(`Token reuse detected! Revoking all sessions for user: ${decoded.userId}`);
      // Revoke all tokens for this user
      await db
        .update(refreshTokens)
        .set({ isRevoked: true })
        .where(eq(refreshTokens.userId, decoded.userId));

      res.clearCookie('refreshToken', COOKIE_OPTIONS);
      return res.status(401).json({ error: 'Session compromised. Please log in again.' });
    }

    // 2. Token is valid. Rotate it.
    // Invalidate old token
    await db
      .update(refreshTokens)
      .set({ isRevoked: true })
      .where(eq(refreshTokens.id, decoded.tokenId));

    // Issue new pair
    const newRefreshTokenId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    const newRefreshToken = generateRefreshToken(decoded.userId, newRefreshTokenId);

    await db.insert(refreshTokens).values({
      id: newRefreshTokenId,
      token: newRefreshToken,
      userId: decoded.userId,
      expiresAt,
    });

    const accessToken = generateAccessToken(decoded.userId);

    res.cookie('refreshToken', newRefreshToken, COOKIE_OPTIONS);
    return res.json({ accessToken });
  } catch (error: any) {
    console.error('Refresh token error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// LOGOUT
router.post('/logout', async (req: Request, res: Response) => {
  const token = req.cookies.refreshToken;
  if (token) {
    try {
      const decoded = jwt.decode(token) as RefreshTokenPayload;
      if (decoded?.tokenId) {
        // Delete or revoke the token in DB
        await db.delete(refreshTokens).where(eq(refreshTokens.id, decoded.tokenId));
      }
    } catch (err) {
      console.error('Error during token revocation on logout:', err);
    }
  }

  res.clearCookie('refreshToken', COOKIE_OPTIONS);
  return res.json({ success: true });
});

export default router;
