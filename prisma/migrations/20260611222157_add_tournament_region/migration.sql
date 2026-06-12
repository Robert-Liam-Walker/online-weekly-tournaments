-- CreateEnum
CREATE TYPE "Region" AS ENUM ('EU', 'NA_EAST', 'NA_WEST');

-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN     "region" "Region";
