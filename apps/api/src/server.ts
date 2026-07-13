import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import http from 'http';
import dotenv from 'dotenv';
import path from 'path';
import authRouter from './routes/auth';
import chatRouter from './routes/chat';
import prekeysRouter from './routes/prekeys';
import { initWebSocketServer } from './socket/gateway';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const port = process.env.PORT || 3001;

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// REST Routes
app.use('/api/auth', authRouter);
app.use('/api/chat', chatRouter);
app.use('/api/chat', prekeysRouter);

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

const server = http.createServer(app);

// Init WebSocket connection handler
initWebSocketServer(server);

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
export { app, server };
