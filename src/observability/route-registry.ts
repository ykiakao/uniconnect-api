export class RouteRegistry {
  private readonly routes: Array<{ method: string; template: string; pattern: RegExp }> = [];

  register(method: string, template: string) {
    const pattern = template.split('/').map((part) => part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/');
    this.routes.push({ method: method.toUpperCase(), template, pattern: new RegExp(`^${pattern}/?$`, 'i') });
  }

  resolve(method: string, path: string) {
    return this.routes.find((route) => (route.method === method || (method === 'HEAD' && route.method === 'GET') || method === 'OPTIONS') && route.pattern.test(path))?.template ?? 'unmatched';
  }
}
