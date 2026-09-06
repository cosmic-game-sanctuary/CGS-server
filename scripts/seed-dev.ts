// seed:      tsx scripts/seed-dev.ts
// wipe:      tsx scripts/seed-dev.ts --wipe
//
// Catalog rows for local frontend work, and nothing more. These games have no
// build and no HTS token on purpose: pinning and minting cost real testnet
// resources, and the first genuinely purchasable game should come from the
// publish flow itself rather than from a script that fakes its way past it.
// So a seeded game browses, filters, sorts and opens — and refuses to sell,
// which is the correct answer for a row with no build behind it.
//
// Everything it writes is owned by one obvious placeholder user, so --wipe can
// remove exactly what this created and nothing anyone else made.
import { eq, inArray } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { users, studios, studioMembers, games, splits, reviews } from "../src/db/schema.js";
import { env } from "../src/config/env.js";
import { slugify } from "../src/lib/slug.js";

const SEED_EMAIL = "seed@cgs.local";

// Splits have to name a payable account or a sale would fail on them. The
// operator is the only account this script can be sure exists, and a seeded
// game can't be bought anyway, so it stands in for every seeded collaborator.
const SEED_WALLET = env.HEDERA_OPERATOR_ID;

type SeedStudio = { name: string; bio: string; ens?: string };
type SeedGame = {
  studio: string;
  title: string;
  tagline: string;
  description: string;
  tags: string[];
  priceUsd: number;
  coverSeed: number;
  daysAgo: number;
  splits: { handle: string; role: string; pct: number }[];
  reviews?: { rating: number; body: string }[];
};

const STUDIOS: SeedStudio[] = [
  { name: "Tin Roof", bio: "Three people, one jam, no publisher. We make small sad games about buildings.", ens: "tinroof" },
  { name: "Small Hours", bio: "Nocturnal two-person studio. Everything we ship was finished after 1am." },
  { name: "Drift Co.", bio: "Slow games for fast weeks." },
  { name: "Moss Collective", bio: "A rotating group of five who met in a game jam Discord and never left." },
  { name: "Paper Lung", bio: "One person. Mostly typing." },
  { name: "Bright Salt", bio: "We were on itch until we weren't." },
];

const GAMES: SeedGame[] = [
  {
    studio: "Tin Roof",
    title: "Hollowgrave",
    tagline: "Dig down. Something is already there.",
    description:
      "A one-button descent into a mine that keeps getting deeper than it should. Every run reshuffles the tunnels, and the lantern only lasts so long. Built in nine days for a jam about verticality, then finished properly because we could not stop playing it.\n\nNo save files, no meta-progression, no currency. You go down, you come back up, or you do not.",
    tags: ["roguelike", "atmospheric", "one-button"],
    priceUsd: 3,
    coverSeed: 11,
    daysAgo: 4,
    splits: [
      { handle: "miracode", role: "code", pct: 50 },
      { handle: "junart", role: "art", pct: 30 },
      { handle: "olamusic", role: "music", pct: 20 },
    ],
    reviews: [
      { rating: 5, body: "Got to floor 14 and the lantern went out while I was reading a note. Sat there in the dark for a second genuinely upset. Great game." },
      { rating: 4, body: "One button is doing a lot of work here and it mostly holds. Wish the map reshuffled a little less aggressively on death." },
      { rating: 5, body: "Bought it, played it in the same tab about four seconds later. Still slightly suspicious that worked." },
    ],
  },
  {
    studio: "Small Hours",
    title: "Tin Halo",
    tagline: "A saint made of scrap, walking home.",
    description:
      "A short walking game with no combat and no fail state. You are a small tin figure crossing a red country toward a house you may have invented. Takes about twenty minutes. Play it with sound on.\n\nFree because the first one should be.",
    tags: ["narrative", "short", "no-fail"],
    priceUsd: 0,
    coverSeed: 2,
    daysAgo: 9,
    splits: [
      { handle: "devi", role: "code + art", pct: 60 },
      { handle: "ashwin", role: "writing", pct: 40 },
    ],
    reviews: [{ rating: 5, body: "Twenty minutes and I have thought about the ending every day since. Play it with headphones." }],
  },
  {
    studio: "Moss Collective",
    title: "Moss & Rust",
    tagline: "Terraform a dead satellite with nothing but patience.",
    description:
      "A slow builder about coaxing life back onto a hulk in orbit. Place moss, wait, place more. There is no threat and no timer; the only pressure is that the station keeps drifting further from the sun.\n\nMade by five people who have never been in the same room.",
    tags: ["builder", "idle", "cozy"],
    priceUsd: 1.8,
    coverSeed: 5,
    daysAgo: 18,
    splits: [
      { handle: "renn", role: "code", pct: 35 },
      { handle: "plum", role: "art", pct: 25 },
      { handle: "kestrel", role: "design", pct: 20 },
      { handle: "sable", role: "music", pct: 20 },
    ],
    reviews: [{ rating: 4, body: "Left it running on a second monitor for a week. That is a compliment." }],
  },
  {
    studio: "Drift Co.",
    title: "Paperclip Ocean",
    tagline: "Fold a boat. Sail it into weather you cannot fold.",
    description:
      "An origami sailing game with real fluid simulation and absolutely no tutorial. Fold your hull between crossings; every crease you add costs you somewhere else.\n\nRuns at 60fps in a browser tab on a five-year-old laptop, which took longer than the game did.",
    tags: ["physics", "sailing", "no-tutorial"],
    priceUsd: 5,
    coverSeed: 8,
    daysAgo: 26,
    splits: [
      { handle: "aria", role: "engine", pct: 40 },
      { handle: "toma", role: "art", pct: 30 },
      { handle: "bex", role: "design", pct: 20 },
      { handle: "nils", role: "audio", pct: 10 },
    ],
  },
  {
    studio: "Paper Lung",
    title: "Last Bus to Anywhere",
    tagline: "Everyone on board is going home. You are not sure you are.",
    description:
      "A conversation game set on a night bus that never quite arrives. Eleven passengers, one route, and a driver who will answer exactly one question. Branching is small and deliberate; you will see most of it in two runs.",
    tags: ["narrative", "dialogue", "short"],
    priceUsd: 2.5,
    coverSeed: 14,
    daysAgo: 33,
    splits: [{ handle: "wren", role: "everything", pct: 100 }],
    reviews: [
      { rating: 5, body: "Asked the driver the wrong question on my first run and thought about it for two days." },
      { rating: 4, body: "Short, and it knows it. The second run is where it lands." },
    ],
  },
  {
    studio: "Bright Salt",
    title: "Saltflat Derby",
    tagline: "Drive very fast in a straight line. Try to keep the wheels on.",
    description:
      "Land-speed racing reduced to its only interesting decision: when to lift. One track, one car, one minute per attempt, and a leaderboard that resets every Sunday.",
    tags: ["racing", "arcade", "leaderboard"],
    priceUsd: 1.5,
    coverSeed: 3,
    daysAgo: 38,
    splits: [
      { handle: "ines", role: "code", pct: 55 },
      { handle: "gus", role: "art + audio", pct: 45 },
    ],
    reviews: [{ rating: 3, body: "Fun for an hour. The leaderboard reset is doing most of the work keeping me here." }],
  },
  {
    studio: "Paper Lung",
    title: "Lantern Arithmetic",
    tagline: "A puzzle box that teaches you its own maths.",
    description:
      "Forty rooms, no words. Each room introduces one rule and then immediately tests whether you actually learned it. The last ten rooms are genuinely hard and we are not sorry.",
    tags: ["puzzle", "wordless", "hard"],
    priceUsd: 4,
    coverSeed: 6,
    daysAgo: 46,
    splits: [{ handle: "wren", role: "everything", pct: 100 }],
    reviews: [
      { rating: 5, body: "Room 34 made me get up and walk around the flat. No words the entire time." },
      { rating: 5, body: "The best wordless teaching I have seen in a puzzle game since Baba." },
    ],
  },
  {
    studio: "Moss Collective",
    title: "Thicket",
    tagline: "Grow a hedge maze. Live in it.",
    description:
      "Part gardener, part cartographer. You plant the maze and then have to find your way back through it from memory. Autumn arrives on turn forty and takes the leaves with it.",
    tags: ["strategy", "cozy", "seasonal"],
    priceUsd: 0,
    coverSeed: 9,
    daysAgo: 54,
    splits: [
      { handle: "renn", role: "code", pct: 50 },
      { handle: "plum", role: "art", pct: 50 },
    ],
  },
  {
    studio: "Drift Co.",
    title: "Switchback",
    tagline: "One mountain. Twelve routes. Weather that does not care.",
    description:
      "A climbing game about route-reading rather than reflexes. Pick a line, commit, and find out whether the weather agrees with you. Every ascent is timed but nothing is a race.",
    tags: ["climbing", "simulation", "weather"],
    priceUsd: 3.5,
    coverSeed: 12,
    daysAgo: 66,
    splits: [
      { handle: "aria", role: "code", pct: 45 },
      { handle: "toma", role: "art", pct: 35 },
      { handle: "nils", role: "audio", pct: 20 },
    ],
    reviews: [{ rating: 4, body: "Read the wrong line on the north face six times before it clicked. Then it really clicked." }],
  },
  {
    studio: "Bright Salt",
    title: "Small Gods of the Tram Network",
    tagline: "Every line has a spirit. Most of them are tired.",
    description:
      "Manage a city tram network in which each route is a minor deity with opinions about punctuality. Keep them happy, keep them running, or watch the timetable become mythology.",
    tags: ["management", "comedy", "city"],
    priceUsd: 6,
    coverSeed: 1,
    daysAgo: 73,
    splits: [
      { handle: "ines", role: "code", pct: 50 },
      { handle: "gus", role: "art", pct: 30 },
      { handle: "dara", role: "writing", pct: 20 },
    ],
  },
  {
    studio: "Small Hours",
    title: "Undertow",
    tagline: "Swim down. The light gets more interesting.",
    description:
      "A breath-holding descent with no enemies and one rule: you must always be able to get back. Procedural kelp, real caustics, and a pressure gauge that is the entire UI.",
    tags: ["atmospheric", "diving", "minimal-ui"],
    priceUsd: 2,
    coverSeed: 4,
    daysAgo: 82,
    splits: [
      { handle: "devi", role: "code", pct: 50 },
      { handle: "ashwin", role: "art + audio", pct: 50 },
    ],
    reviews: [{ rating: 5, body: "The pressure gauge being the whole UI is the kind of restraint I wish more games had." }],
  },
  {
    studio: "Tin Roof",
    title: "Ninefold",
    tagline: "A card game against nine versions of yourself.",
    description:
      "Deckbuilder where every card you play is added to your opponent's deck for the next round. Nine rounds, escalating, and by round seven you are losing to your own best ideas.",
    tags: ["deckbuilder", "strategy", "roguelike"],
    priceUsd: 4.5,
    coverSeed: 7,
    daysAgo: 90,
    splits: [
      { handle: "miracode", role: "code", pct: 45 },
      { handle: "junart", role: "art", pct: 35 },
      { handle: "olamusic", role: "music", pct: 20 },
    ],
    reviews: [{ rating: 5, body: "Round seven is a genuinely great feeling. Losing to a deck you built by playing well." }],
  },
];

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const toUnits = (usd: number) => Math.round(usd * 10 ** env.X402_ASSET_DECIMALS);

async function wipe() {
  const seedUser = await db.query.users.findFirst({ where: eq(users.email, SEED_EMAIL) });
  if (!seedUser) {
    console.log("nothing seeded — no placeholder user found");
    return;
  }

  const seedStudios = await db.query.studios.findMany({ where: eq(studios.ownerUserId, seedUser.id) });
  const studioIds = seedStudios.map((s) => s.id);

  if (studioIds.length > 0) {
    const seedGames = await db.query.games.findMany({ where: inArray(games.studioId, studioIds) });
    const gameIds = seedGames.map((g) => g.id);
    if (gameIds.length > 0) {
      await db.delete(reviews).where(inArray(reviews.gameId, gameIds));
      await db.delete(splits).where(inArray(splits.gameId, gameIds));
      await db.delete(games).where(inArray(games.id, gameIds));
    }
    await db.delete(studioMembers).where(inArray(studioMembers.studioId, studioIds));
    await db.delete(studios).where(inArray(studios.id, studioIds));
    console.log(`removed ${seedGames.length} games and ${studioIds.length} studios`);
  }

  await db.delete(users).where(eq(users.id, seedUser.id));
  console.log("removed the placeholder user");
}

async function seed() {
  const existing = await db.query.users.findFirst({ where: eq(users.email, SEED_EMAIL) });
  if (existing) {
    console.log("already seeded. run with --wipe first to reset.");
    return;
  }

  // A row that satisfies the foreign keys and could never be signed into:
  // the DID is not a Privy DID and there is no wallet behind the address.
  const [seedUser] = await db
    .insert(users)
    .values({
      privyDid: "seed:local-development",
      email: SEED_EMAIL,
      evmAddress: "0x0000000000000000000000000000000000000000",
      privyWalletId: "seed",
      publicKeyHex: "seed",
    })
    .returning();

  const studioIdByName = new Map<string, string>();
  for (const s of STUDIOS) {
    const [row] = await db
      .insert(studios)
      .values({ ownerUserId: seedUser!.id, name: s.name, slug: slugify(s.name), bio: s.bio, ensSubname: s.ens })
      .returning();
    studioIdByName.set(s.name, row!.id);
  }

  // Members, so the "3 people" on a listing is counted rather than invented.
  const handlesByStudio = new Map<string, Set<string>>();
  for (const g of GAMES) {
    const set = handlesByStudio.get(g.studio) ?? new Set<string>();
    for (const m of g.splits) set.add(m.handle);
    handlesByStudio.set(g.studio, set);
  }
  for (const [studioName, handles] of handlesByStudio) {
    const studioId = studioIdByName.get(studioName)!;
    await db.insert(studioMembers).values(
      [...handles].map((handle, i) => ({
        studioId,
        email: `${handle}@cgs.local`,
        handle,
        role: (i === 0 ? "owner" : "member") as "owner" | "member",
        acceptedAt: new Date(),
      })),
    );
  }

  for (const g of GAMES) {
    const [game] = await db
      .insert(games)
      .values({
        studioId: studioIdByName.get(g.studio)!,
        slug: slugify(g.title),
        title: g.title,
        tagline: g.tagline,
        description: g.description,
        tags: g.tags,
        coverSeed: g.coverSeed,
        priceUnits: toUnits(g.priceUsd),
        priceAsset: env.X402_ASSET,
        status: "published",
        publishedAt: daysAgo(g.daysAgo),
        buildSizeKb: 1400 + g.coverSeed * 320,
      })
      .returning();

    await db.insert(splits).values(g.splits.map((s) => ({ gameId: game!.id, wallet: SEED_WALLET, ...s })));

    if (g.reviews?.length) {
      await db.insert(reviews).values(
        g.reviews.map((r, i) => ({
          gameId: game!.id,
          userId: seedUser!.id,
          rating: r.rating,
          body: r.body,
          createdAt: daysAgo(Math.max(0, g.daysAgo - i - 1)),
        })),
      );
    }
  }

  console.log(`seeded ${STUDIOS.length} studios and ${GAMES.length} games.`);
  console.log("no builds and no tokens, so these browse but cannot be bought. --wipe removes all of it.");
}

await (process.argv.includes("--wipe") ? wipe() : seed());
process.exit(0);
