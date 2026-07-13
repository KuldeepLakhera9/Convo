CREATE TABLE IF NOT EXISTS "device_prekeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"identity_key" text NOT NULL,
	"signed_prekey" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unique_user_device" UNIQUE("user_id","device_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "encrypted_payloads" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_prekeys" ADD CONSTRAINT "device_prekeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
