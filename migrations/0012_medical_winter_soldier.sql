PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_inference_spend` (
	`project_id` text PRIMARY KEY NOT NULL,
	`minutes` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_inference_spend`("project_id", "minutes", "created_at") SELECT "project_id", "minutes", "created_at" FROM `inference_spend`;--> statement-breakpoint
DROP TABLE `inference_spend`;--> statement-breakpoint
ALTER TABLE `__new_inference_spend` RENAME TO `inference_spend`;--> statement-breakpoint
PRAGMA foreign_keys=ON;