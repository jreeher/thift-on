-- Checkout now collects first name + phone instead of email (customer_name/customer_phone
-- already existed as unused nullable columns). customer_email stays for historical orders
-- but is no longer required going forward.
ALTER TABLE orders ALTER COLUMN customer_email DROP NOT NULL;
