-- AlterTable
ALTER TABLE "User" ADD COLUMN     "displayName" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_displayName_key" ON "User"("displayName");
