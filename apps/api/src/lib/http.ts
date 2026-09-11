import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Encapsula handlers assíncronos para propagar erros ao errorHandler (Express 4). */
export function h(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
