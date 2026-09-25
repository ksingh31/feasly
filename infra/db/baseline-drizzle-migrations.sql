-- baseline-drizzle-migrations.sql
-- Populates __drizzle_migrations with the exact hashes drizzle-kit expects,
-- so future `drizzle-kit migrate` runs correctly see all migrations as applied.
-- Hash = sha256(file content) per drizzle-orm's readMigrationFiles.
-- Idempotent: only inserts hashes not already present.

CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);

INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT 'e2cd489dff13a889011169859d4e16329e6cd3f362abdb0a1213e7603635a806', 1790272502261
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = 'e2cd489dff13a889011169859d4e16329e6cd3f362abdb0a1213e7603635a806');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT 'caba134ce2072e8a31ad665cdaca0cce701d211012047ac98f5061ee14199a5e', 1790281363380
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = 'caba134ce2072e8a31ad665cdaca0cce701d211012047ac98f5061ee14199a5e');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT 'd5b2651be867c0ddfad104284477c00e7f318cef3385cf121e432d20eb728349', 1791000000000
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = 'd5b2651be867c0ddfad104284477c00e7f318cef3385cf121e432d20eb728349');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT 'c8241ea96bfb4d0130a6e82d630b92087eda67cdf1ab8df77e727597036029e8', 1790283322128
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = 'c8241ea96bfb4d0130a6e82d630b92087eda67cdf1ab8df77e727597036029e8');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT '4239d102063af5ca48a13fdb1f52793d2090c012f0821e581be865ba0f7fec9a', 1790296494702
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = '4239d102063af5ca48a13fdb1f52793d2090c012f0821e581be865ba0f7fec9a');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT 'dba4a16812f7412087399a857ba05cfe7563e55e5cb80b1e5a343c27197c4f45', 1790298186970
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = 'dba4a16812f7412087399a857ba05cfe7563e55e5cb80b1e5a343c27197c4f45');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT '6e10768a94e3dd00e81a0edb634b7ebf7bc31b12b252a919346a13585ed86d22', 1790299347642
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = '6e10768a94e3dd00e81a0edb634b7ebf7bc31b12b252a919346a13585ed86d22');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT 'a13def11a3cd778155ea42456b1f9a5ecc14312c4fdda5ca25ece233f4992d9b', 1790301416458
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = 'a13def11a3cd778155ea42456b1f9a5ecc14312c4fdda5ca25ece233f4992d9b');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT '6191f167b7699b308d1abe30b4b0b129dab0712996d603a428aeafd00c7cb3b3', 1790301963911
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = '6191f167b7699b308d1abe30b4b0b129dab0712996d603a428aeafd00c7cb3b3');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT '7f2a830e8526071ebac72d87b172e0872708793bfc67717dedffdf0d14094c07', 1790302500316
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = '7f2a830e8526071ebac72d87b172e0872708793bfc67717dedffdf0d14094c07');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT '97d9eb688c395d908aaf1cafe5d61bb696b9e9eeb238dd3b507585c8ea1931c6', 1790302735742
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = '97d9eb688c395d908aaf1cafe5d61bb696b9e9eeb238dd3b507585c8ea1931c6');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT 'a234a21e8606331754071d222e2ac8685250bde83b461fe5cc4fafe9afce5988', 1790302908610
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = 'a234a21e8606331754071d222e2ac8685250bde83b461fe5cc4fafe9afce5988');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT '0d66a7b2ac6b515046ed722c4f75a1e8a3f84a5308118d74b67667281194e539', 1790303000000
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = '0d66a7b2ac6b515046ed722c4f75a1e8a3f84a5308118d74b67667281194e539');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT '28b8f7a7e59a30ef821462d625b654c5d3ffeda970808dc96569b52450d11694', 1790310781184
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = '28b8f7a7e59a30ef821462d625b654c5d3ffeda970808dc96569b52450d11694');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT 'bc2cc3f13304bdd0bd997b8bf0f8d77160d8b955aeedd17e7cc62a6cf1cca832', 1790311000000
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = 'bc2cc3f13304bdd0bd997b8bf0f8d77160d8b955aeedd17e7cc62a6cf1cca832');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT '5038fc1a8e1b0b3f3a54ac84c3019a314282636e8cddbe228c6aa9f008349726', 1790310000000
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = '5038fc1a8e1b0b3f3a54ac84c3019a314282636e8cddbe228c6aa9f008349726');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT '605683ac349fb52a0796ce494dcbdffc09b1830e920300a3adefe2b655583f00', 1790313706792
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = '605683ac349fb52a0796ce494dcbdffc09b1830e920300a3adefe2b655583f00');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT '5c3b500557fe0582822b64c1641186b78d717f9c309f9d2ddf2057df6689f80d', 1790316259442
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = '5c3b500557fe0582822b64c1641186b78d717f9c309f9d2ddf2057df6689f80d');
INSERT INTO "__drizzle_migrations" ("hash", "created_at")
SELECT '061408bb42dba96309a9f7c5882fcd709c2c8fa34e21be993e7410351b940969', 1790336770698
WHERE NOT EXISTS (SELECT 1 FROM "__drizzle_migrations" WHERE "hash" = '061408bb42dba96309a9f7c5882fcd709c2c8fa34e21be993e7410351b940969');
