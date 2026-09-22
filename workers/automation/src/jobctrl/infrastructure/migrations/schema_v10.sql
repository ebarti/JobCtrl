CREATE TABLE job_application_locators (
    tenant_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    application_url TEXT NOT NULL,
    PRIMARY KEY (tenant_id, job_id, application_url),
    FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
);
CREATE INDEX idx_job_application_locators_url
    ON job_application_locators(tenant_id, application_url);
INSERT INTO job_application_locators (tenant_id, job_id, application_url)
    SELECT tenant_id, job_id, application_url FROM jobs
        WHERE application_url IS NOT NULL AND application_url <> ''
    UNION
    SELECT tenant_id, job_id, application_url FROM job_enrichments
        WHERE application_url IS NOT NULL AND application_url <> '';
UPDATE job_enrichments
    SET application_url = (
        SELECT jobs.application_url FROM jobs
        WHERE jobs.tenant_id = job_enrichments.tenant_id
            AND jobs.job_id = job_enrichments.job_id
    )
    WHERE (application_url IS NULL OR application_url = '')
        AND EXISTS (
            SELECT 1 FROM jobs
            WHERE jobs.tenant_id = job_enrichments.tenant_id
                AND jobs.job_id = job_enrichments.job_id
                AND jobs.application_url IS NOT NULL AND jobs.application_url <> ''
        );
INSERT INTO job_enrichments (
    tenant_id, job_id, current_status, application_url, attempts_json, updated_at
)
    SELECT tenant_id, job_id, 'pending', application_url, '[]',
        COALESCE(NULLIF(detail_scraped_at, ''), NULLIF(discovered_at, ''),
            '1970-01-01T00:00:00+00:00')
    FROM jobs
    WHERE application_url IS NOT NULL AND application_url <> ''
        AND NOT EXISTS (
            SELECT 1 FROM job_enrichments
            WHERE job_enrichments.tenant_id = jobs.tenant_id
                AND job_enrichments.job_id = jobs.job_id
        );
ALTER TABLE jobs DROP COLUMN application_url;
