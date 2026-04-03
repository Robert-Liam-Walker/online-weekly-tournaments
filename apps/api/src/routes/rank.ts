import { FastifyInstance } from "fastify";
import { redis } from "../lib/redis";
import { requireAuth } from "../plugins/auth";

const SLIPPI_GQL = "https://gql-gateway-eu-prod.slippi.gg/graphql";
const CACHE_TTL = 60 * 60; // 1 hour

const RANK_QUERY = `
  query GetRank($code: String!) {
    getConnectCode(code: $code) {
      user {
        displayName
        rankedNetplayProfile {
          ratingOrdinal
          wins
          losses
          dailyGlobalPlacement
          dailyRegionalPlacement
          continent
        }
      }
    }
  }
`;

export interface SlippiRank {
  displayName: string | null;
  rating: number | null;
  wins: number;
  losses: number;
  tier: string;
  globalPlacement: number | null;
}

const TIERS = [
  { name: "Grandmaster", min: 1491.15 },
  { name: "Master",      min: 1316.68 },
  { name: "Diamond",     min: 1188.56 },
  { name: "Platinum",    min: 1054.13 },
  { name: "Gold",        min: 913.58  },
  { name: "Silver",      min: 765.43  },
  { name: "Bronze",      min: 0       },
];

function getTier(rating: number | null): string {
  if (rating === null) return "Unranked";
  return TIERS.find((t) => rating >= t.min)?.name ?? "Unranked";
}

export async function rankRoutes(app: FastifyInstance) {
  app.get("/:connectCode", { preHandler: [requireAuth] }, async (request, reply) => {
    const { connectCode } = request.params as { connectCode: string };

    // Check Redis cache
    const cacheKey = `rank:${connectCode.toUpperCase()}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as SlippiRank;

    try {
      const res = await fetch(SLIPPI_GQL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: RANK_QUERY, variables: { code: connectCode } }),
      });

      if (!res.ok) return reply.code(502).send({ error: "Slippi API unavailable" });

      const json = (await res.json()) as {
        data?: {
          getConnectCode?: {
            user?: {
              displayName?: string;
              rankedNetplayProfile?: {
                ratingOrdinal?: number;
                wins?: number;
                losses?: number;
                dailyGlobalPlacement?: number;
              };
            };
          };
        };
      };

      const profile = json.data?.getConnectCode?.user?.rankedNetplayProfile ?? null;
      const rating = profile?.ratingOrdinal ?? null;

      const rank: SlippiRank = {
        displayName: json.data?.getConnectCode?.user?.displayName ?? null,
        rating,
        wins: profile?.wins ?? 0,
        losses: profile?.losses ?? 0,
        tier: getTier(rating),
        globalPlacement: profile?.dailyGlobalPlacement ?? null,
      };

      await redis.set(cacheKey, JSON.stringify(rank), "EX", CACHE_TTL);
      return rank;
    } catch {
      return reply.code(502).send({ error: "Failed to fetch rank from Slippi" });
    }
  });
}
