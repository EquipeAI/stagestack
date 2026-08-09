import { defineApp } from "convex/server";
import resend from "@convex-dev/resend/convex.config.js";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";

const app = defineApp();
app.use(resend);
app.use(rateLimiter);

export default app;
