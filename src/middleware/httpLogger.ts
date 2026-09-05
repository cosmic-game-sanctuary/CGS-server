import { pinoHttp } from "pino-http";
import { Request, Response } from "express";
import logger from "../utils/logger.utils.js"

const httpLogger = pinoHttp({
  logger,
  serializers: {
    req: (req: Request) => ({method: req.method, url: req.url}),
    res: (res: Response) => ({statusCode: res.statusCode}),
  },
});

export default httpLogger;
