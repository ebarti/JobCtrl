ALTER TABLE llm_spend RENAME TO llm_spend_v10;
CREATE TABLE llm_spend (
            day           TEXT NOT NULL,
            lane          TEXT NOT NULL CHECK (lane IN ('legacy', 'discovery', 'enrichment', 'scoring', 'tailoring', 'apply', 'contact', 'interview', 'profile', 'compensation')),
            input_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
            output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
            estimated_usd REAL NOT NULL DEFAULT 0 CHECK (estimated_usd >= 0),
            PRIMARY KEY (day, lane)
        );
INSERT INTO llm_spend (day, lane, input_tokens, output_tokens, estimated_usd)
SELECT day, 'legacy', input_tokens, output_tokens, estimated_usd
FROM llm_spend_v10;
DROP TABLE llm_spend_v10;
