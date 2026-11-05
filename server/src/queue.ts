import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';

export const connection = () => new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
export const QUEUE = 'generate';
export const genQueue = new Queue(QUEUE, {
  connection: connection(),
  defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000, attempts: 1 },
});
export const redis = connection();
