-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "ReviewStage" AS ENUM ('INITIAL', 'ONE_WEEK', 'ONE_MONTH', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR', 'TWO_YEARS', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ReviewSource" AS ENUM ('NATIVE', 'IMPORTED');

-- CreateEnum
CREATE TYPE "AggregationSource" AS ENUM ('AMAZON', 'GOOGLE', 'YELP', 'STEAM', 'GOODREADS', 'TRIPADVISOR', 'MANUAL');

-- CreateEnum
CREATE TYPE "PriceTier" AS ENUM ('BUDGET', 'MID_RANGE', 'PREMIUM', 'LUXURY');

-- CreateEnum
CREATE TYPE "AgeRange" AS ENUM ('AGE_18_24', 'AGE_25_34', 'AGE_35_44', 'AGE_45_54', 'AGE_55_64', 'AGE_65_PLUS');

-- CreateEnum
CREATE TYPE "IncomeBracket" AS ENUM ('UNDER_30K', 'RANGE_30_50K', 'RANGE_50_75K', 'RANGE_75_100K', 'RANGE_100_150K', 'OVER_150K');

-- CreateEnum
CREATE TYPE "EducationLevel" AS ENUM ('HIGH_SCHOOL', 'SOME_COLLEGE', 'BACHELORS', 'MASTERS', 'DOCTORATE', 'OTHER');

-- CreateEnum
CREATE TYPE "NudgeStatus" AS ENUM ('PENDING', 'SENT', 'COMPLETED', 'SKIPPED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_demographics" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ageRange" "AgeRange",
    "genderIdentity" TEXT,
    "region" TEXT,
    "incomeBracket" "IncomeBracket",
    "lifestyleTags" TEXT[],
    "householdSize" INTEGER,
    "hasChildren" BOOLEAN,
    "educationLevel" "EducationLevel",
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_demographics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "description" TEXT,
    "imageUrl" TEXT,
    "websiteUrl" TEXT,
    "priceTier" "PriceTier",
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "amazonAsin" TEXT,
    "googlePlaceId" TEXT,
    "yelpId" TEXT,
    "steamAppId" TEXT,
    "goodreadsId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "avgRatingInitial" DOUBLE PRECISION,
    "avgRatingLongterm" DOUBLE PRECISION,
    "driftScoreAvg" DOUBLE PRECISION,
    "totalReviewCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_threads" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "driftScore" DOUBLE PRECISION,
    "stagesCompleted" "ReviewStage"[],

    CONSTRAINT "review_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "stage" "ReviewStage" NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "ReviewSource" NOT NULL DEFAULT 'NATIVE',
    "scoreOverall" INTEGER NOT NULL,
    "scoreValue" INTEGER,
    "scoreQuality" INTEGER,
    "scoreLongevity" INTEGER,
    "scoreExpectations" INTEGER,
    "bodyText" TEXT,
    "pros" TEXT[],
    "cons" TEXT[],
    "wouldStillBuy" BOOLEAN,
    "wouldRecommend" BOOLEAN,
    "sentimentScore" DOUBLE PRECISION,
    "keyTopics" TEXT[],
    "summaryAuto" TEXT,
    "externalId" TEXT,
    "externalUrl" TEXT,
    "externalAuthor" TEXT,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aggregated_reviews" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "source" "AggregationSource" NOT NULL,
    "externalId" TEXT NOT NULL,
    "authorName" TEXT,
    "rating" DOUBLE PRECISION NOT NULL,
    "bodyText" TEXT,
    "reviewDate" TIMESTAMP(3),
    "verifiedPurchase" BOOLEAN NOT NULL DEFAULT false,
    "sentimentScore" DOUBLE PRECISION,
    "keyTopics" TEXT[],
    "pros" TEXT[],
    "cons" TEXT[],
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aggregated_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nudges" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "targetStage" "ReviewStage" NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "status" "NudgeStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "nudges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "user_demographics_userId_key" ON "user_demographics"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "products_amazonAsin_key" ON "products"("amazonAsin");

-- CreateIndex
CREATE UNIQUE INDEX "products_googlePlaceId_key" ON "products"("googlePlaceId");

-- CreateIndex
CREATE UNIQUE INDEX "products_yelpId_key" ON "products"("yelpId");

-- CreateIndex
CREATE UNIQUE INDEX "products_steamAppId_key" ON "products"("steamAppId");

-- CreateIndex
CREATE UNIQUE INDEX "products_goodreadsId_key" ON "products"("goodreadsId");

-- CreateIndex
CREATE INDEX "products_category_idx" ON "products"("category");

-- CreateIndex
CREATE INDEX "products_brand_idx" ON "products"("brand");

-- CreateIndex
CREATE UNIQUE INDEX "review_threads_userId_productId_key" ON "review_threads"("userId", "productId");

-- CreateIndex
CREATE INDEX "reviews_threadId_idx" ON "reviews"("threadId");

-- CreateIndex
CREATE INDEX "reviews_stage_idx" ON "reviews"("stage");

-- CreateIndex
CREATE UNIQUE INDEX "aggregated_reviews_source_externalId_key" ON "aggregated_reviews"("source", "externalId");

-- CreateIndex
CREATE INDEX "nudges_userId_status_idx" ON "nudges"("userId", "status");

-- CreateIndex
CREATE INDEX "nudges_scheduledFor_status_idx" ON "nudges"("scheduledFor", "status");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_key" ON "refresh_tokens"("token");

-- AddForeignKey
ALTER TABLE "user_demographics" ADD CONSTRAINT "user_demographics_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_threads" ADD CONSTRAINT "review_threads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_threads" ADD CONSTRAINT "review_threads_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "review_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aggregated_reviews" ADD CONSTRAINT "aggregated_reviews_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "review_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

