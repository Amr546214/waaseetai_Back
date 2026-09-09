-- Add context JSON column to messages table for discussion context (project/stage/delivery reference)
ALTER TABLE "messages" ADD COLUMN "context" JSON;
