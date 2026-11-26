-- ZIP code as its own field (it was only inside the address text), filled from the FMCSA census.
ALTER TABLE companies ADD COLUMN zip_code TEXT;
UPDATE companies SET zip_code = CASE
  WHEN address GLOB '*, [0-9][0-9][0-9][0-9][0-9]' THEN substr(address, -5)
  WHEN address GLOB '*, [0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]' THEN substr(address, -10, 5)
END WHERE zip_code IS NULL;
CREATE INDEX IF NOT EXISTS idx_companies_mc ON companies (mc_number);
