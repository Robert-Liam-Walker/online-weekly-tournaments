-- Usernames become the sole identity; connect codes are removed entirely.

-- DropIndex
DROP INDEX "User_connectCode_key";

-- AlterTable: rename (preserves existing parsed data)
ALTER TABLE "TournamentReplay" RENAME COLUMN "parsedWinnerCode" TO "parsedWinnerName";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "connectCode";

-- Case-insensitive uniqueness: DB-level index is the source of truth.
CREATE UNIQUE INDEX "User_username_lower_key" ON "User" (lower(username));
