import type { AppInstance } from '../app-instance';

export async function registerHealthRoutes(app: AppInstance): Promise<void> {
  app.get('/api/v1/health', async () => ({ status: 'ok' }));
}
