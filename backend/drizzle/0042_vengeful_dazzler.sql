CREATE TABLE `contract_release_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_sha256` text NOT NULL,
	`release_version` text NOT NULL,
	`git_sha` text NOT NULL,
	`bundle_json` text NOT NULL,
	`prepared_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contract_release_evidence_bundle_sha_unique_idx` ON `contract_release_evidence` (`bundle_sha256`);--> statement-breakpoint
CREATE INDEX `contract_release_evidence_prepared_at_idx` ON `contract_release_evidence` (`prepared_at`);--> statement-breakpoint
CREATE TABLE `contract_release_state` (
	`singleton_key` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`active_evidence_id` text NOT NULL,
	`phase` text NOT NULL,
	`activated_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`active_evidence_id`) REFERENCES `contract_release_evidence`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
