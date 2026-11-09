CREATE ROLE sales_user LOGIN PASSWORD 'phase54_test_only';
CREATE ROLE inventory_user LOGIN PASSWORD 'phase54_test_only';
CREATE ROLE report_user LOGIN PASSWORD 'phase54_test_only';
CREATE SCHEMA sales AUTHORIZATION sales_user;
CREATE SCHEMA inventory AUTHORIZATION inventory_user;
CREATE SCHEMA report AUTHORIZATION report_user;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
