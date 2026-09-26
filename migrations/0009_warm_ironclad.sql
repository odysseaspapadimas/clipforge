CREATE TABLE `media_slot` (
	`slot` integer PRIMARY KEY NOT NULL,
	`holder` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
INSERT INTO `media_slot` (`slot`, `holder`, `generation`, `lease_until`) VALUES (0, NULL, 0, 0), (1, NULL, 0, 0);
