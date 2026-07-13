import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Create separate Redis connections for general client operations and Pub/Sub subscriptions
export const redisPublisher = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

export const redisSubscriber = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

redisPublisher.on('connect', () => console.log('Redis Publisher connected'));
redisSubscriber.on('connect', () => console.log('Redis Subscriber connected'));

redisPublisher.on('error', (err) => console.error('Redis Publisher connection error:', err));
redisSubscriber.on('error', (err) => console.error('Redis Subscriber connection error:', err));
