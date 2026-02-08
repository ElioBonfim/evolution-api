import { CacheConf, CacheConfRedis, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { createClient, RedisClientType } from 'redis';

class Redis {
  private logger = new Logger('Redis');
  private client: RedisClientType = null;
  private conf: CacheConfRedis;
  private connected = false;
  private connecting = false;

  constructor() {
    this.conf = configService.get<CacheConf>('CACHE')?.REDIS;
  }

  getConnection(): RedisClientType {
    if (this.connected && this.client) {
      return this.client;
    }

    if (this.connecting) {
      return this.client;
    }

    this.connecting = true;

    const isInternalHost = this.conf.URI?.includes('.railway.internal');

    this.logger.verbose(`redis URI: ${this.conf.URI ? this.conf.URI.replace(/\/\/.*@/, '//***@') : 'NOT SET'}`);

    this.client = createClient({
      url: this.conf.URI,
      socket: {
        family: isInternalHost ? 6 : undefined,
        reconnectStrategy: (retries) => {
          const delay = Math.min(retries * 500, 30000);
          this.logger.verbose(`redis reconnecting in ${delay}ms (attempt ${retries})`);
          return delay;
        },
      },
    });

    this.client.on('connect', () => {
      this.logger.verbose('redis connecting');
    });

    this.client.on('ready', () => {
      this.logger.verbose('redis ready');
      this.connected = true;
    });

    this.client.on('error', (error) => {
      if (this.connected) {
        this.logger.error('redis disconnected: ' + (error?.message || error));
      }
      this.connected = false;
    });

    this.client.on('end', () => {
      this.logger.verbose('redis connection ended');
      this.connected = false;
    });

    this.client
      .connect()
      .then(() => {
        this.connected = true;
        this.logger.verbose('redis connected successfully');
      })
      .catch((e) => {
        this.connected = false;
        this.logger.error('redis connect failed: ' + (e?.message || e));
      })
      .finally(() => {
        this.connecting = false;
      });

    return this.client;
  }
}

export const redisClient = new Redis();
