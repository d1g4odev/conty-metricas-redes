import { createContext } from "./context.js";
import { systemClock } from "./domain/clock.js";
import { toIsoDay } from "./domain/dates.js";
import { buildApp } from "./http/app.js";

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => toIsoDay(new Date(systemClock.now().getTime() - days * DAY_MS));

const context = createContext({
  clock: systemClock,
  policy: { maxRetryAfterMs: 5_000, requestTimeoutMs: 2_000, maxTotalWaitMs: 15_000 },
  pageSize: 10,
});

context.simulator?.addAccount({
  platform: "instagram",
  accountId: "acct_demo",
  token: "fake-token-demo",
  posts: [
    { postId: "post_a", publishedOn: daysAgo(30) },
    { postId: "post_b", publishedOn: daysAgo(12) },
    { postId: "post_c", publishedOn: daysAgo(3) },
  ],
});

const app = buildApp(context);
const port = Number(process.env.PORT ?? 3000);

app.listen({ port, host: "0.0.0.0" }).then(
  (address) => console.log(`metricas-redes listening on ${address}`),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
