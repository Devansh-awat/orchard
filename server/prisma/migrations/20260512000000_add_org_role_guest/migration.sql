-- Add `guest` variant to OrganizationRole enum.
-- Guests are users who belong to an org only because they were invited to a
-- specific project. They cannot create projects, cannot see org settings, and
-- cannot see projects they are not explicit members of.
ALTER TYPE "organization_role" ADD VALUE 'guest';
