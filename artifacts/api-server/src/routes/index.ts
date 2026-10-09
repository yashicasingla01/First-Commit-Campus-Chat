import { Router, type IRouter } from "express";
import healthRouter from "./health";
import campusChatRouter from "./campus-chat";

const router: IRouter = Router();

router.use(healthRouter);
router.use(campusChatRouter);

export default router;
