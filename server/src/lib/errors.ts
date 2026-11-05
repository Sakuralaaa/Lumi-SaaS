export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const bad = (msg: string, code = 'bad_request') => new HttpError(400, code, msg);
export const unauthorized = () => new HttpError(401, 'unauthorized', '请先登录');
export const forbidden = () => new HttpError(403, 'forbidden', '没有权限');
export const notFound = () => new HttpError(404, 'not_found', '不存在');
