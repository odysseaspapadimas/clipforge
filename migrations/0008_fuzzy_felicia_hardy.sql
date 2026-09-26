CREATE TABLE `inference_spend` (
	`project_id` text PRIMARY KEY NOT NULL,
	`minutes` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
