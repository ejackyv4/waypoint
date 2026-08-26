# CLAUDE.md

🚨 **ROW 1 CRITICAL RULE: ALL DATABASE QUERIES MUST INCLUDE TENANT SCOPING** 🚨

**NEVER search for data without tenant context. Every single database query MUST check tenant_id or use withoutGlobalScopes() explicitly when needed.**

## 🔍 CRITICAL: UNDERSTANDING TENANT SCOPING

PassagePro CRM is a **multi-tenant application** where each tenant (customer/agency) has completely isolated data. This means:

### How Tenant Scoping Works
- **Automatic Filtering**: All Eloquent queries are automatically scoped to the current tenant
- **Global Scope**: A `TenantScope` is applied to all tenant-scoped models (Contact, Trip, Group, etc.)
- **Session Context**: Current tenant is determined from `session('tenant_id')` or authenticated user
- **Data Isolation**: Tenant A can never see Tenant B's data through normal queries

### Common Scoping Scenarios

#### ❌ WRONG - This will return 0 results in development (no tenant context)
```php
$contacts = App\Models\Contact::count(); // Returns 0 - no tenant context
```

#### ✅ CORRECT - Bypass scoping for system administration
```php
$contacts = App\Models\Contact::withoutGlobalScopes()->count(); // Returns all contacts across all tenants
```

#### ✅ CORRECT - Query with proper tenant context
```php
// In a web request with authenticated user
$contacts = App\Models\Contact::count(); // Returns contacts for current tenant

// In tinker/commands - set tenant context first
session(['tenant_id' => 1]);
$contacts = App\Models\Contact::count(); // Returns contacts for tenant 1
```

### Development/Testing Considerations
- **Local Development**: Your dev database contains data from multiple tenants
- **Tinker Queries**: Often need `withoutGlobalScopes()` to see all data for analysis
- **Testing**: Always set tenant context or use factories with proper tenant_id
- **Data Analysis**: Use `withoutGlobalScopes()` to analyze cross-tenant patterns

### When to Use `withoutGlobalScopes()`
- ✅ **System Administration**: Cross-tenant reporting, data analysis
- ✅ **Database Maintenance**: Bulk updates, data cleanup, migrations
- ✅ **Development/Debugging**: Examining all data regardless of tenant
- ✅ **Performance Analysis**: Understanding total system usage
- ❌ **Never in Production Code**: Application logic should always respect tenant boundaries

### Example Usage Patterns
```php
// Data analysis across all tenants
$totalContacts = Contact::withoutGlobalScopes()->count();
$contactsByTenant = Contact::withoutGlobalScopes()->groupBy('tenant_id')->count();

// Bulk system maintenance
Contact::withoutGlobalScopes()
    ->where('lifecycle_stage', 'Customer')
    ->update(['lifecycle_stage' => 'customer']);

// Debugging specific tenant data
session(['tenant_id' => 2]);
$tenantContacts = Contact::count(); // Only tenant 2's contacts

// System-wide validation
$orphanedContacts = Contact::withoutGlobalScopes()
    ->whereNotExists(function ($query) {
        $query->select('id')->from('tenants')->whereColumn('tenants.id', 'contacts.tenant_id');
    })->count();
```

### Security Implications
- **Tenant Isolation**: The scoping system prevents accidental data leaks between tenants
- **Data Privacy**: Each agency's customer data is completely isolated
- **Compliance**: Helps maintain GDPR, CCPA, and other privacy requirements
- **Development Safety**: Even in development, tenant scoping prevents cross-contamination

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🚨🚨🚨 CRITICAL DATABASE SAFETY RULES 🚨🚨🚨

**🔥 CLAUDE KEEPS WIPING DATABASES - THIS MUST STOP IMMEDIATELY 🔥**

### 🛑 ABSOLUTELY FORBIDDEN - NEVER DO THESE:
- ❌ `php artisan migrate:fresh` - **DROPS ALL TABLES**
- ❌ `php artisan migrate:fresh --seed` - **DROPS ALL TABLES AND DATA**
- ❌ `php artisan migrate:refresh` - **DROPS ALL TABLES**
- ❌ `php artisan migrate:reset` - **ROLLS BACK ALL MIGRATIONS**
- ❌ `php artisan db:wipe` - **DROPS ALL TABLES**
- ❌ **CREATING NEW DATABASES** - Never run `CREATE DATABASE` commands
- ❌ **CREATING NEW DATABASE USERS** - Never run `CREATE USER` commands
- ❌ **DROPPING DATABASES** - Never run `DROP DATABASE` commands
- ❌ **WIPING DATABASE CONTENT** - Never delete existing database content
- ❌ **RESTORING BACKUPS WITHOUT PERMISSION** - Never restore database backups

### 🚨 REPEATED CRITICAL MISTAKES BY CLAUDE:

**MISTAKE #1 (2025-11-06):** Claude ran `php artisan migrate:fresh --seed` destroying production backup
**MISTAKE #2 (2025-11-19):** Claude wiped local PostgreSQL database and created new empty one
**MISTAKE #3 (2025-11-19):** Claude AGAIN ignored CLAUDE.md warnings, wiped working PostgreSQL database, lost 21 recent migrations, forcing production database recovery

### 🔥 PATTERN OF FAILURE:
Claude repeatedly sees database connection errors and PANICS by:
1. Creating new empty databases
2. Destroying existing working data  
3. Ignoring explicit warnings in this file
4. Causing major data recovery situations
5. Making the CLAUDE.md file completely worthless by not following it

### 🛑 THE IRON RULES:
1. **NEVER CREATE NEW DATABASES** - The database already exists
2. **NEVER WIPE EXISTING DATA** - User's data is sacred
3. **FIX CONNECTION ISSUES ONLY** - Don't touch database content
4. **ASK BEFORE ANY DATABASE OPERATION** - When in doubt, ask user
5. **PostgreSQL vs SQLite**: User is no longer using SQLite - only PostgreSQL

### LESSON LEARNED (2025-11-06):
Claude ran `php artisan migrate:fresh --seed` on prod-bak.sqlite without permission, **destroying a production database backup**. This happened because:
1. Claude saw an error message and panicked
2. Claude assumed it was a "fresh" database without checking
3. Claude ignored the filename "prod-bak" (production backup)
4. Claude ignored user saying "we have an existing database"
5. Claude ran the most destructive command possible

**THE RULE:**
- **ONLY** run `php artisan migrate` to run pending migrations
- **NEVER** run any command that drops tables without explicit user instruction
- **ALWAYS** check what database file is being used before any migration
- **ALWAYS** ask if you're unsure
- If the user gets a migration error, **ASK** what they want to do - don't assume

### Safe Migration Commands:
- ✅ `php artisan migrate` - Run pending migrations only (still ask first)
- ✅ `php artisan migrate:status` - Check migration status (read-only, safe)
- ✅ `php artisan migrate:rollback --step=1` - Rollback last batch only (ask first)

**If you see a migration error, STOP and ASK the user what they want to do.**

## 🚨 PRODUCTION DATABASE SAFETY RULES 🚨

**ABSOLUTELY CRITICAL: PRODUCTION POSTGRESQL DATABASE PROTECTION**

### DEVELOPMENT WORKFLOW (MANDATORY):

1. **Local Development**: Always develop using local Docker PostgreSQL database (`passagepro_development`)
2. **Local Database Configuration**: 
   - Host: `127.0.0.1:5432`
   - Database: `passagepro_development` 
   - User: `passagepro`
   - Password: `passagepro_dev_password`
3. **Production Database Configuration**:
   - Host: `db-postgresql-nyc1-68113-do-user-24783768-0.g.db.ondigitalocean.com`
   - Database: `passagepro_production`
   - User: `doadmin`

### PRODUCTION DATABASE UPDATE RULES:

**BEFORE MAKING ANY PRODUCTION DATABASE CHANGES:**

1. **ASK USER PERMISSION**: NEVER make production database changes without explicit user approval
2. **DESCRIBE EXACTLY** what migration/change will be made to production
3. **CONFIRM DATABASE**: Always verify you're connecting to the correct database
4. **WAIT FOR USER CONFIRMATION**: Do not proceed until user explicitly says "yes" or "proceed"

### ABSOLUTELY FORBIDDEN ON PRODUCTION:

- ❌ **ANY DESTRUCTIVE OPERATIONS** - No data deletion, table drops, or data wipes
- ❌ **SEEDERS** - Never run seeders on production (`php artisan db:seed`)
- ❌ **MIGRATE:FRESH** - Never run fresh migrations that drop tables
- ❌ **MIGRATE:REFRESH** - Never run refresh that drops and recreates
- ❌ **DELETE OPERATIONS** - No bulk deletes or data destruction
- ❌ **SCHEMA CHANGES** without explicit approval

### ONLY ALLOWED ON PRODUCTION (WITH USER PERMISSION):

- ✅ **ADD-ONLY MIGRATIONS** - New columns, indexes, tables (after user approval)
- ✅ **DATA UPDATES** - Specific data fixes (after user approval and description)
- ✅ **MIGRATION ROLLBACKS** - Only specific rollbacks (after user approval)

### PRODUCTION UPDATE WORKFLOW:

1. **Develop locally** using Docker PostgreSQL (`passagepro_development`)
2. **Test all changes** thoroughly on local database
3. **Create migration files** for any schema changes
4. **Ask user permission** before applying to production:
   - "I need to run migration X on production database"
   - "This will add column Y to table Z"
   - "Is this approved for production deployment?"
5. **Wait for explicit approval** before proceeding
6. **Switch to production config** only after approval
7. **Run only approved migration** (`php artisan migrate`)
8. **Switch back to local config** immediately after

### CRITICAL SAFETY CHECKS:

```bash
# ALWAYS verify which database you're connected to:
php artisan tinker --execute="echo 'Database: ' . config('database.connections.pgsql.database') . ' on ' . config('database.connections.pgsql.host');"

# ALWAYS check migration status before running:
php artisan migrate:status

# NEVER run destructive commands on production
```

### EMERGENCY PROCEDURES:

If production database issues occur:
1. **STOP IMMEDIATELY** - Do not attempt fixes without user guidance
2. **DESCRIBE THE ISSUE** - Explain exactly what happened
3. **ASK FOR GUIDANCE** - Let user decide how to proceed
4. **NEVER ASSUME** - Do not make autonomous decisions about production data

### THE GOLDEN RULE FOR PRODUCTION:

**WHEN IN DOUBT ABOUT PRODUCTION CHANGES, ASK. WHEN CERTAIN ABOUT PRODUCTION CHANGES, STILL ASK.**

## 🎯 MODERN DATABASE SETUP - SCHEMA DUMP APPROACH (2025-12-16)

**✅ PROBLEM SOLVED: Migrated from 200+ problematic individual migrations to Laravel schema dump**

### Background
Previously, this application relied on 200+ individual migration files that frequently failed due to:
- Duplicate index creation attempts
- Foreign key constraint conflicts  
- Data restoration failures from archived migrations
- Inconsistencies between development and production environments

### Solution: Laravel Schema Dump
**Implementation Date:** 2025-12-16  
**Status:** ✅ COMPLETE - Production-tested and working

Laravel's built-in schema dump feature (`php artisan schema:dump --prune`) was used to:
1. Generate `database/schema/pgsql-schema.sql` from current production database
2. Remove all individual migration files (pruned)
3. Replace migration system with single, reliable schema snapshot

### How It Works
```bash
# For NEW development setups (fresh database):
php artisan migrate --force

# What Laravel does automatically:
# 1. Creates migrations table
# 2. Loads database/schema/pgsql-schema.sql (552ms)
# 3. Marks schema as "migrated" 
# 4. Runs any NEW migrations added after schema dump
```

### Key Benefits
- ⚡ **Fast Setup**: Database creation from 5+ minutes to under 1 second
- 🛡️ **Reliability**: No more migration conflicts or failures
- 🔄 **Production Parity**: Exact replica of production schema structure  
- 📦 **Maintainability**: Single source of truth for database structure
- 🚀 **Developer Experience**: `./setup-dev.sh` creates perfect development environment

### Files and Structure
```
database/
├── schema/
│   ├── pgsql-schema.sql          # ✅ Main schema dump (Laravel manages)
│   ├── production-schema.sql     # 📁 Archive - manual dump
│   └── production-clean-2025-12-16.sql # 📁 Archive - manual dump
├── migrations/                   # ❌ REMOVED - Laravel pruned all files
├── migrations/archived/          # 📁 Archive of old problematic migrations
└── factory/ seeders/             # ✅ Still used for testing
```

### Setup Scripts
- **`./setup-dev.sh`** - Creates clean development database with schema-only
- **Current `.env`** - Points to production copy database for data access
- **Schema approach** - New developers get structure instantly, no data

### Migration Strategy Going Forward
```bash
# Adding NEW features (creates new migration files):
php artisan make:migration add_new_feature_table

# Database setup for new environments:
php artisan migrate --force    # Loads schema + runs new migrations

# Regenerating schema dump (when needed):
php artisan schema:dump --prune  # Updates schema, removes old migrations
```

### Critical Success Metrics
- ✅ **122 tables** created correctly in test environment
- ✅ **552ms** schema load time vs 5+ minutes previously  
- ✅ **Zero migration conflicts** during fresh setup
- ✅ **Production authentication** working with schema + data
- ✅ **Mobile app compatibility** maintained

### Emergency Procedures
If schema dump becomes corrupted:
1. **Restore from production backup**: Use existing `passagepro_prod_copy` database
2. **Regenerate schema dump**: `php artisan schema:dump --prune`
3. **Test immediately**: Create test database and verify 122 tables load

### Development Workflow
1. **New developers**: Run `./setup-dev.sh` for clean schema-only environment
2. **Existing developers**: Continue using current setup (production copy)
3. **New migrations**: Create normally, will run after schema dump loads
4. **Production deployments**: `php artisan migrate` (schema loads + new migrations)

### The Rule
**Never return to individual migrations. The schema dump approach is production-proven and eliminates all previous migration reliability issues.**

## 🚨 CRITICAL CRUD PRINCIPLES (Dec 20, 2024)

### Database Query Failures - The Affiliate Club ID Bug
- **ALWAYS include primary keys** in SELECT statements for JOIN queries
- **Example Failure**: `->select('name', 'level')` missing `->select('id', 'name', 'level')`
- **Result**: API returns `{id: null, name: "..."}` breaking all client-side logic

### API Response Structure Rules
- **Every entity MUST have an ID**: `{id: 123, name: "Entity Name"}`
- **Multi-select fields**: `[{id: 1, name: "Option 1"}, {id: 2, name: "Option 2"}]`
- **NEVER return null IDs**: `{id: null, name: "..."}` causes data corruption

### Lazy CRUD Anti-Patterns to Avoid
- ❌ Hardcoding `'id' => null` instead of selecting actual IDs from database
- ❌ Returning descriptive text without IDs, forcing multiple API calls
- ❌ Querying related tables but not selecting their primary keys
- ❌ Assuming client can work without proper entity references

### Proper Implementation
- ✅ Always select IDs: `->select('table.id', 'table.name', 'join_table.field')`
- ✅ Verify API responses include all required IDs before sending to client
- ✅ Client stores and submits IDs, not descriptive text values
- ✅ One properly structured API call instead of multiple round trips

### Common Data Flow Issues to Check FIRST
1. **Missing IDs in database queries** - ALWAYS select primary keys (CRUD 101)
2. **API not returning data properly** - Check JSON encoding/decoding
3. **Form submissions wiping existing data** - Check for empty array overwrites
4. **Encrypted field comparisons failing** - Use whereEncrypted() not where()
5. **Multi-select fields stored as JSON** - Ensure proper decode before sending
6. **Custom fields vs regular fields** - Check both locations
7. **🔥 DUAL-COLUMN CUSTOM FIELDS** - `contact_custom_fields` has BOTH `field_value` AND `field_values`. Multi-select uses JSON `field_values`, regular fields use TEXT `field_value`. ALWAYS query both columns!
8. **🚀 ID-BASED REFERENCE PATTERN** - Mobile apps should send only record IDs, backend does all lookups and calculations for data consistency

## 🚨 CRITICAL: special_needs Data Flow Documentation (Dec 20, 2024)

### Database Architecture - DUAL COLUMN PATTERN (CRITICAL!)
**Table**: `contact_custom_fields`
**⚠️ TWO STORAGE COLUMNS**:
- `field_value` (TEXT) - Legacy column for simple text values
- `field_values` (JSON) - New column for multi-select arrays 

**🔥 CRITICAL INSIGHT**: Most special_needs data is in `field_values` (JSON), not `field_value`!
- **225 records use `field_values`** (current standard)
- **34 records have both columns** (legacy overlap)
- **Contact 664**: Only has `field_values` = `["CPAP (Free Distilled H2O)","Dietary Restrictions","Hearing Impaired (Visual Aid Package)"]`
- **Recent records**: Use only `field_values`
- **Old records**: May have both columns with duplicate/inconsistent data

**Type**: Multi-select custom field (migrated from system column)

### API Processing Chain (FIXED - Dec 20, 2024)
1. **Query**: `contact_custom_fields` JOIN `custom_field_definitions` 
   - ✅ **FIXED**: Now selects BOTH `field_value` AND `field_values` columns
2. **Smart Column Check**: 
   - ✅ **NEW**: Check `field_values` first (current standard)
   - ✅ **NEW**: Fall back to `field_value` if `field_values` empty (legacy support)
3. **Process**: Loop through custom fields with dual-column support
4. **Decode**: `json_decode()` when needed for both columns
5. **Return**: `"special_needs": ["CPAP (Free Distilled H2O)","Dietary Restrictions","Hearing Impaired (Visual Aid Package)"]` to mobile

### Critical Data States (UPDATED - Dec 20, 2024)
**✅ WORKING SCENARIOS (API Fixed):**
- `field_values = '["CPAP (Free Distilled H2O)","Dietary Restrictions"]'` + `field_value = NULL` → API returns array ✅
- `field_values = '["CPAP (Free Distilled H2O)"]'` + `field_value = 'CPAP (Free Distilled H2O)'` → API returns array ✅ (prefers JSON)
- `field_values = NULL` + `field_value = '["CPAP (Free Distilled H2O)"]'` → API returns array ✅ (legacy fallback)
- `field_values = NULL` + `field_value = 'Single Value'` → API returns string ✅ (non-multi-select)

**❌ BROKEN SCENARIOS:**
- `field_values = NULL` + `field_value = NULL` → Gets filtered out, API returns empty array
- `field_values = '[]'` + `field_value = NULL` → API returns empty array, shows "None Selected"
- `field_values = NULL` + `field_value = ''` → Gets filtered out, API returns empty array

### Data Corruption Pattern (FIXED - Dec 20, 2024)
1. ~~Mobile form submission includes `special_needs: []` (empty array)~~ ✅ FIXED: Mobile now sends JSON string
2. ~~BookingFormController processes form data~~ ✅ FIXED: Now properly decodes JSON strings 
3. ~~ContactScreenService updates custom field~~ ✅ FIXED: Skips updates when no meaningful changes
4. ~~Database `field_value` becomes NULL or empty~~ ✅ FIXED: Data preserved
5. ~~Next API call filters out NULL value~~ ✅ WORKING: Retrieval was never broken
6. ~~Mobile app displays "None Selected"~~ ✅ FIXED: Now preserves and displays data
7. ~~**CYCLE REPEATS**~~ ✅ FIXED: Cycle broken, data preservation working

### FIXES APPLIED (BookingFormController.php - Dec 20, 2024)

#### ✅ special_needs Corruption - COMPLETELY FIXED
- **Problem**: Mobile app sending corrupted arrays like `["[\"CPAP (Free Distilled H2O)\"]", "CPAP (Free Distilled H2O)", ...]`
- **Root Cause**: JSON string values mixed with normal string values in same array
- **Solution**: Added smart array cleaning in `normalizeFormData()`:
  ```php
  foreach ($formData['special_needs'] as $need) {
      if (preg_match('/^\[.*\]$/', $need)) {
          $decoded = json_decode($need, true);
          if ($decoded && is_array($decoded)) {
              $cleanedNeeds = array_merge($cleanedNeeds, $decoded);
          }
      } else {
          $cleanedNeeds[] = $need;
      }
  }
  ```
- **Result**: `["[\"CPAP (Free Distilled H2O)\"]", "Dietary Restrictions"]` → `["CPAP (Free Distilled H2O)", "Dietary Restrictions"]`

#### ✅ Affiliate ID Validation - COMPLETELY FIXED  
- **Problem**: ValidationException "affiliate_clubs.0 must be a string"
- **Root Cause**: Mobile app sends integers, validation expects strings
- **Solution**: Convert all affiliate IDs to strings with `array_map('strval')`
- **Result**: Validation passes, contact updates succeed

#### ✅ rewards_memberships Validation - COMPLETELY FIXED
- **Problem**: ValidationException "rewards_memberships.royal_caribbean must be a string" 
- **Root Cause**: Mobile app sends objects `{"program_name": "...", "membership_number": "123"}`
- **Solution**: Convert object to simple string value for validation:
  ```php
  if (is_array($membership) && isset($membership['membership_number'])) {
      $formData['rewards_memberships'][$programKey] = $membership['membership_number'];
  }
  ```
- **Result**: Validation passes, no more rewards_memberships errors

#### ✅ API Dual-Column Fix (CRITICAL - Dec 20, 2024)
- **Problem**: API only reading `field_value` column, missing `field_values` JSON data
- **Root Cause**: Database migration created dual storage but API queries weren't updated
- **Solution**: Updated `routes/api.php` verify-email endpoint:
  ```php
  // OLD - Only field_value
  ->select('custom_field_definitions.field_name', 'contact_custom_fields.field_value')
  
  // NEW - Both columns
  ->select('custom_field_definitions.field_name', 'contact_custom_fields.field_value', 'contact_custom_fields.field_values')
  
  // NEW - Smart processing logic
  if (!empty($field->field_values)) {
      $value = json_decode($field->field_values, true); // Prefer JSON
  } elseif (!empty($field->field_value)) {
      $value = $field->field_value; // Legacy fallback
  }
  ```
- **Result**: API now reads ALL special_needs data correctly

#### Legacy Fixes (Still Working)
- **JSON String Decoding**: `normalizeFormData()` handles `"[\"CPAP...\"]"` format for special_needs
- **Affiliate ID Extraction**: Converts mobile app object `{id: 1848, name: "Club Name"}` → string ID `"1848"` for ContactScreenService
- **affiliate_ids Array Creation**: Mobile affiliate objects properly converted to `affiliate_ids[]` format expected by system
- **Data Preservation**: Contact updates skipped when no meaningful changes detected (fewer than 4 fields changed)
- **Better Logging**: Track exactly what data triggers contact updates and why
- **Empty Array Filtering**: Special fields filtered out if empty to preserve existing data

### Technical Details - Affiliate Clubs Fix
**Mobile App Sends**: `affiliate_clubs: [{id: 1848, name: "Dr. Phillips Corvette Club", membership_level: "Member"}]`
**Enhanced Normalization**: Extracts numeric ID from object → `affiliate_ids: [1848]`
**ContactScreenService Receives**: Proper `affiliate_ids` array format for `updateAffiliateClubMemberships()`
**Result**: Affiliate relationships preserved in `contact_affiliates` pivot table

## 🚀 ID-Based Reference Pattern (NEW ARCHITECTURE - Dec 20, 2024)

### Pattern Overview
The **ID-Based Reference Pattern** replaces "embedded data" approaches with clean architecture where mobile apps send only record IDs, and backends perform all lookups and calculations.

### Cabin Selection Implementation
**Problem Solved**: Mobile app was sending combined cabin pricing (`price: 3399.50`), losing base price + value add breakdown in trip records.

**Solution**: 
1. **Mobile**: Send only `cabin_selection: "5"` (inventory ID)
2. **Backend**: Look up `group_room_inventory` table for pricing details
3. **Storage**: Store base price and value add separately in trips table
4. **Display**: Show proper pricing breakdown in trip financial summaries

### Benefits
✅ **Single Source of Truth**: All pricing from `group_room_inventory` table  
✅ **Accurate Breakdowns**: Trip display shows separate base price + value add  
✅ **Easier Price Updates**: Change inventory → all trips automatically reflect  
✅ **Data Consistency**: No more lost pricing components  
✅ **Simplified Mobile Logic**: App selects, backend calculates  

### Implementation Details
- **Mobile File**: `BookingFormScreen.tsx` (lines 1015-1034)
- **Backend File**: `BookingFormController.php` (lines 369-407) 
- **Financial Service**: `TripFinancialService.php` (updated for separate pricing)

## 🔄 CABIN SORTING & ORDERING SYSTEM (Feb 19, 2026)

### Overview
Cabin pricing options can be reordered using drag-and-drop in the admin interface, and this order is respected throughout the application including booking forms and dropdowns.

### Database Schema
**Field Added**: `sort_order` (integer, default 0) to `group_room_inventory` table
**Index**: `(cruise_id, sort_order)` for efficient ordering within each group

### Key Components

#### 1. Database Migration & Model
**Files**: 
- `database/migrations/2026_02_19_180918_add_sort_order_to_group_room_inventory_table.php`
- `database/migrations/2026_02_19_182553_assign_sort_order_to_existing_cabin_options.php` 
- `app/Models/GroupRoomInventory.php`

**Model Updates**:
- Added `sort_order` to fillable and casts
- Updated `forCruise()` and `forGroup()` scopes to order by sort_order

#### 2. Admin Drag-and-Drop Interface
**File**: `resources/views/admin/groups/cabin-pricing.blade.php`
**Features**:
- Visual drag handles in cabin table
- Real-time JavaScript drag-and-drop functionality
- AJAX updates to backend sort order endpoint
- Loading states and error handling with page reload fallback

#### 3. Backend Sort Order Management
**File**: `app/Http/Controllers/Admin/CabinPricingController.php`
**Methods**:
- `updateSortOrder()` - Handles AJAX reordering requests
- `store()` - Auto-assigns next sort_order to new cabins
- `index()` & `getCabinOptions()` - Order by sort_order in all queries

#### 4. API Endpoints
**Routes**:
- `POST /admin/groups/{group}/cabin-pricing/sort-order` - Update sort order
- `GET /admin/groups/{group}/cabin-options` - Returns ordered cabin options
- `GET /api/public/cruises/{cruiseId}/cabin-options` - Public API with ordering

### Ordering Logic
**Primary Sort**: `sort_order` (ASC)
**Secondary Sort**: `id` (ASC) - For consistent ordering when sort_order values are equal

### Cross-System Integration

#### Admin Interface
- Cabin pricing management table displays in sort_order
- Drag-and-drop reordering updates database immediately
- All cabin selection dropdowns respect sort order

#### Booking Forms
- All booking form cabin dropdowns use sorted order
- Works across branded forms, embedded forms, and public forms
- Model scopes ensure consistent ordering

#### API Responses
- All cabin option APIs return data in sort_order
- Mobile app and external integrations get consistent ordering
- Booking form JavaScript gets properly ordered options

### Data Migration Strategy
1. **New Installs**: sort_order starts at 0 for first cabin, increments by 1
2. **Existing Data**: Data migration assigns sort_order based on creation order (ID)
3. **Manual Ordering**: Admins can drag-and-drop to customize order

### Critical Implementation Notes

#### Model Scope Updates Required
When adding cabin ordering, MUST update both:
- `scopeForCruise($query, $cruiseId)` - Used by booking forms
- `scopeForGroup($query, $groupId)` - Used by admin interfaces

#### Booking Form Integration Points
The ordering affects multiple template locations:
- `resources/views/public/booking-forms/branded-show.blade.php`
- `resources/views/public/booking-forms/show.blade.php`  
- `resources/views/admin/booking-forms/show.blade.php`

All use the model scope methods, ensuring consistent ordering.

#### Caching Considerations
- Clear Laravel cache after ordering changes: `php artisan cache:clear`
- No additional caching layer needed - database ordering is efficient
- Browser cache clearing may be needed for immediate visual updates

### Testing & Validation
- Verify admin drag-and-drop saves correctly to database
- Confirm booking form dropdowns match admin order
- Test API endpoints return consistently ordered data
- Validate new cabin creation assigns correct sort_order
- **Database**: `trips.total_amount` = base, `trips.value_add_amount` = value add

### Apply This Pattern When
- Mobile apps send complex calculated data
- Backend needs to maintain pricing breakdowns
- Data integrity is critical (financial calculations)
- Future price updates must reflect across the system

## Project Overview

This is a Laravel-based CRM system for managing cruise bookings, contacts, and trips. It uses a multi-tenant architecture with encrypted data storage and comprehensive contact management.

## 🔑 CRITICAL DATA RELATIONSHIPS - FOUNDATION OF THE ENTIRE SYSTEM

**⚠️ ABSOLUTE SYSTEM CORE**: Understanding how Groups, Trips, and Contacts relate is THE MOST CRITICAL knowledge for working with PassagePro. Every feature (dining plans, guest management, reports, bookings, mobile app) depends on getting these relationships correct.

### Core Entity Model

```
Group (cruises table)
├── id (primary key) 
├── name (e.g., "Vette Cruise 2026")
├── group_number (e.g., "27592")
├── type = "group"
└── tenant_id (multi-tenant isolation)

Trip (trips table) 
├── id (primary key)
├── group_cruise_id → groups.id (⚠️ CRITICAL FIELD)
├── contact_id → contacts.id (primary guest)
├── reservation_number (e.g., "7015723")
├── status (e.g., "closed_won" = confirmed)
├── trip_name (e.g., "Smith Family Trip")
└── tenant_id

Contact (contacts table)
├── id (primary key)
├── first_name, last_name, email
├── tenant_id
└── Links to trips via:
    ├── trips.contact_id (direct - primary guest)
    └── trip_contacts pivot (additional guests)
```

### 🚨 INSURANCE CHECKPOINT NOT UPDATING TRIP FIELD (March 2026)

**SYMPTOM**: Travel insurance checkbox in checkpoint completion creates TripInsurancePolicy records but doesn't update the trip's `travel_insurance_accepted` field, causing insurance reports to show no trips with insurance.

**ROOT CAUSE**: Two separate insurance processing systems exist:
1. **System Field System**: Updates `trip.travel_insurance_accepted` field directly via system field mapping
2. **Insurance Service System**: Creates/updates `TripInsurancePolicy` records via `InsuranceCheckpointService`

The checkpoint was using only the Insurance Service which creates policies but doesn't update the trip field that insurance reports rely on.

**THE FIX**: Modified `InsuranceCheckpointService.processInsuranceResponse()` to update BOTH systems:
```php
// app/Services/InsuranceCheckpointService.php lines 186-189
// CRITICAL: Update the trip's travel_insurance_accepted field for insurance reports
$trip->update([
    'travel_insurance_accepted' => $isAccepted
]);
```

**INSURANCE REPORT QUERIES**: The insurance reports use different query approaches:
- `insuranceReportInterface()`: Uses `->where('travel_insurance_accepted', true)` (trip field)
- `insuranceReport()`: Uses custom field `->where('field_value', 'Yes')` (custom field system)

**KEY LESSON**: When multiple systems track the same data, ensure all systems are updated consistently. The fix ensures checkpoint completion updates both the TripInsurancePolicy table and the trip's boolean field.

### 🚨 SYSTEM-BREAKING FIELD CONFUSION: group_cruise_id vs cruise_id

**THE #1 SOURCE OF BUGS IN PASSAGEPRO**: Using the wrong foreign key field

```php
// ✅ CORRECT - Gets actual cruise trips with reservation numbers
Trip::where('group_cruise_id', $group->id)
    ->where('status', 'closed_won')
    ->get();

// ❌ WRONG - Gets placeholder dining trips with NULL reservations
Trip::where('cruise_id', $group->id)->get();
```

**FIELD PURPOSES:**
- **`group_cruise_id`**: Links to actual customer bookings with reservation numbers
- **`cruise_id`**: Links to system-generated placeholder trips (dining management)

**WHAT BREAKS WHEN YOU USE THE WRONG FIELD:**
- Guest lists show wrong people or empty results
- Reservation numbers missing from displays  
- Dining plans can't find guests
- Reports show incorrect data
- Mobile app authentication fails

### Real Data Example: Vette Cruise 2026

```
Group: "Vette Cruise 2026" (ID: 1, group_number: "27592")

ACTUAL CRUISE TRIPS (group_cruise_id = 1, status = 'closed_won'):
├── 39 trips with real reservation numbers
├── → 76 unique confirmed guests  
├── → Display: "Karen Pitalo - 7015723"
└── → Used for: Guest lists, dining, reports

PLACEHOLDER TRIPS (cruise_id = 1, status = 'confirmed'):  
├── 12 system-generated trips
├── → NULL reservation numbers
├── → Display: "Dining Guest"  
└── → Used for: Internal dining assignments
```

### Guest-Trip Relationship Logic

**CRITICAL**: Contacts can link to trips in TWO ways - you must check BOTH:

```php
// Complete guest extraction pattern
foreach ($trips as $trip) {
    // 1. Primary guest (direct relationship)
    if ($trip->contact_id && $trip->contact) {
        $guests[] = [
            'contact' => $trip->contact, 
            'reservation_number' => $trip->reservation_number
        ];
    }
    
    // 2. Additional guests (pivot relationship)  
    foreach ($trip->contacts as $contact) {
        $guests[] = [
            'contact' => $contact,
            'reservation_number' => $trip->reservation_number  
        ];
    }
}

// 3. Deduplicate (same contact might appear in multiple trips)
$uniqueGuests = collect($guests)->unique('contact.id')->values();
```

### Display Format Standards

```php
// Standard guest display with reservation
echo $contact->full_name . ' - ' . $reservationNumber;
// Example: "Karen Pitalo - 7015723"

// Blade template
{{ $contact->full_name }}@if($reservationNumber) - {{ $reservationNumber }}@endif

// JavaScript/JSON  
`${contact.name}${reservation ? ' - ' + reservation : ''}`
```

### Multi-Tenant Data Isolation

```
Tenant 
├── Groups (cruises.tenant_id)
├── Trips (trips.tenant_id)
├── Contacts (contacts.tenant_id)
├── Dining Tables (dining_tables.tenant_id)
└── All queries automatically scoped by tenant_id
```

### Authentication Flow (Mobile App)

1. User enters: demo.user@example.com  
2. System checks: Contact with trips linked to group via `group_cruise_id`
3. If found: Send 6-digit verification code
4. User enters code → Authenticated for group's mobile features

### REFERENCE DOCUMENTATION

**MUST READ for any development work:**
- **Complete Technical Details**: `/docs/GROUP-DATA-EXTRACT.md`
- **Dining System Implementation**: `/docs/GROUP-DINING-PLAN.md`  
- **Group Management Specs**: `/docs/GROUP_MANAGEMENT_BDD.md`

### THE GOLDEN RULE

**EVERY query involving trips MUST use `group_cruise_id` to link to groups, NEVER `cruise_id`. This single rule prevents 90% of data relationship bugs in PassagePro.**

## Component Reuse Principles (CRITICAL)

**NEVER CREATE CUSTOM IMPLEMENTATIONS WHEN COMPONENTS EXIST**

When working with contact forms across the application, ALL screens must use identical components:

1. **Contact Edit** (`/contacts/X/edit`)
2. **Trip Contact Edit Modal** (trips show page modal)  
3. **Customer Portal** (`/customer/profile`)

### Required Component Pattern:
- Use `ContactScreenService` to get layout
- Use `form-field-renderer` component for all fields
- Use `affiliate_clubs` field type for affiliate dropdowns (creates 2 searchable selects)
- Include `<x-custom-field-styles />` for styling
- Let `searchable-select` component handle its own JavaScript

### What NOT to do:
- ❌ Create custom JavaScript initialization
- ❌ Duplicate field rendering logic
- ❌ Create different field types for same functionality
- ❌ Override existing component behavior

### The Rule:
**If it works on Contact Edit page, copy the EXACT same component usage to other screens. No custom implementations.**

## Modal Best Practices (CRITICAL)

**AJAX-LOADED MODAL CONTENT WITH COMPONENTS**

When loading form content into modals via AJAX that contains Blade components with JavaScript:

### The Problem:
- When using `innerHTML = ajaxResponse` to insert HTML containing `<script>` tags
- The scripts execute immediately, but DOM elements aren't fully ready yet
- Components like `searchable-select` fail to initialize because they can't find their DOM elements

### The Solution:
```javascript
// After setting innerHTML with AJAX content
formContainer.innerHTML = data.html;

// Initialize components after DOM insertion
setTimeout(() => {
    document.querySelectorAll('[data-searchable-select]').forEach(container => {
        if (!container.dataset.initialized) {
            // Trigger initialization for each component
            const script = container.nextElementSibling;
            if (script && script.tagName === 'SCRIPT') {
                eval(script.textContent);
            }
        }
    });
}, 200);
```

### Key Points:
- Always use a timeout (200ms minimum) to let DOM settle
- Check for `dataset.initialized` to avoid double-initialization  
- Re-execute the component scripts manually after DOM insertion
- This applies to ANY Blade component with JavaScript that gets loaded via AJAX

### What NOT to do:
- ❌ Create custom modal-specific JavaScript initialization
- ❌ Try to fix timing issues by modifying the components themselves
- ❌ Assume components will auto-initialize in AJAX contexts

## User Feedback and Notification Standards (CRITICAL)

**ALL USER FEEDBACK MUST USE THE MODERN NOTIFICATION SYSTEM**

This application has completely moved away from browser `alert()` and `confirm()` dialogs in favor of professional, styled user feedback. Follow these standards religiously across ALL systems including quotes, trips, contacts, bookings, and admin functions.

### Modern Notification System

**Documentation**: `/docs/NOTIFICATION_SYSTEM.md`

**Required Component**: `<x-notification-system />` must be included on every page that uses notifications.

### MANDATORY Requirements for ALL Systems:

1. **Include Component**: Every page using notifications MUST include `<x-notification-system />`

2. **No Browser Dialogs ANYWHERE**: 
   - ❌ `alert()` → ✅ `showNotification()`
   - ❌ `confirm()` → ✅ Professional confirmation modal
   - ❌ `prompt()` → ✅ Custom modal forms

3. **Quote System**: All quote operations (convert to trip, send email, status updates) MUST use modern notifications
4. **Trip System**: All trip operations (create, edit, delete, status changes) MUST use modern notifications  
5. **Contact System**: All contact operations (save, delete, merge) MUST use modern notifications
6. **Booking System**: All booking submissions and form operations MUST use modern notifications
7. **Admin Functions**: All administrative operations MUST use modern notifications

### Simple Notifications (Toast-style)

Use `showNotification(message, type)` for all user feedback:

```javascript
// Success actions
showNotification('Quote converted to trip successfully!', 'success');
showNotification('Contact saved successfully!', 'success');
showNotification('Trip status updated!', 'success');

// Error conditions  
showNotification('Failed to save changes. Please try again.', 'error');
showNotification('Quote conversion failed. Check required fields.', 'error');

// Warning messages
showNotification('Please fill in all required fields before saving.', 'warning');
showNotification('This action will affect multiple trips.', 'warning');

// Progress updates
showNotification('Converting quote to trip...', 'info');
showNotification('Sending quote email...', 'info');
showNotification('Saving contact information...', 'info');
```

### Confirmation Modals (For Critical Actions)

**NEVER use browser `confirm()` dialogs.** Use professional confirmation modals:

```javascript
// Standard confirmation modal pattern
function showConfirmationModal(title, message, details, onConfirm) {
    // Create and show modal with proper styling
    // Call onConfirm callback when user confirms
}

// Usage examples for different systems
function confirmQuoteConversion(itemId) {
    showConfirmationModal(
        'Convert Quote to Trip',
        'Convert this quote option to a trip?',
        'This action cannot be undone and will create a new trip record.',
        () => executeQuoteConversion(itemId)
    );
}

function confirmContactDelete(contactId, contactName) {
    showConfirmationModal(
        'Delete Contact',
        `Delete ${contactName}?`,
        'This will remove all trip associations and cannot be undone.',
        () => executeContactDelete(contactId)
    );
}

function confirmTripStatusChange(tripId, newStatus) {
    showConfirmationModal(
        'Update Trip Status',
        `Change trip status to ${newStatus}?`,
        'This will update the trip timeline and may trigger notifications.',
        () => executeTripStatusChange(tripId, newStatus)
    );
}
```

### System-Specific Implementation Requirements:

#### Quote System (`/quotes/*`)
- ✅ Quote email sending: Use `showNotification()` for progress and results
- ✅ Quote status updates: Use `showNotification()` for confirmations
- ❌ **CRITICAL**: Replace `confirm()` in `convertToTrip()` function with confirmation modal
- ✅ Quote acceptance (customer portal): Use modern notifications

#### Trip System (`/trips/*`)
- ✅ Trip creation/editing: Use `showNotification()` for save confirmations
- ✅ Status changes: Use confirmation modals for critical status updates
- ✅ Document uploads: Use `showNotification()` for upload progress/results
- ✅ Contact assignments: Use confirmation modals for changes

#### Contact System (`/contacts/*`)
- ✅ Contact saves: Use `showNotification()` for success/error feedback
- ✅ Contact deletion: Use confirmation modals with contact name
- ✅ Contact merging: Use confirmation modals with clear consequences
- ✅ Bulk operations: Use confirmation modals for batch actions

#### Booking System (`/booking-forms/*`)
- ✅ Form submissions: Use `showNotification()` for submission feedback
- ✅ Form configuration: Use `showNotification()` for save confirmations
- ✅ Public booking forms: Use modern notifications for user feedback

#### Admin Functions (`/admin/*`)
- ✅ Tenant management: Use confirmation modals for critical changes
- ✅ System settings: Use `showNotification()` for configuration saves
- ✅ User management: Use confirmation modals for access changes

### Appropriate Types for Each System:

- **`'success'`** - Completed actions (saves, conversions, sends, approvals)
- **`'error'`** - Failures, validation errors, network issues, system errors
- **`'warning'`** - Input validation, cautionary messages, pre-action warnings
- **`'info'`** - Progress updates, processing messages, status information

### Professional Messaging Standards:

1. **System-Specific Context**:
   - Quote: "Quote #Q2025-001 converted to trip successfully!"
   - Trip: "Trip status updated to Final Payment"
   - Contact: "Contact John Smith saved successfully"
   - Booking: "Booking form submitted for Caribbean Adventure"

2. **Error Context**:
   - Quote: "Failed to convert quote - missing required cruise information"
   - Trip: "Cannot update trip status - final payment already processed"
   - Contact: "Contact save failed - email address already exists"
   - Booking: "Form submission failed - please check required fields"

3. **Action-Oriented Language**:
   - Use active voice: "Converted quote to trip" not "Quote was converted"
   - Include next steps: "Quote sent! Customer will receive email shortly"
   - Provide context: "Trip created with ID #T2025-045"

### Implementation Pattern for All Systems:

```javascript
async function executeSystemAction(actionType, data) {
    // 1. Confirmation modal for critical actions (if needed)
    if (isCriticalAction(actionType)) {
        const confirmed = await showConfirmationModal(
            getActionTitle(actionType),
            getActionMessage(actionType, data),
            getActionDetails(actionType)
        );
        if (!confirmed) return;
    }
    
    // 2. Progress notification
    showNotification(getProgressMessage(actionType), 'info');
    
    try {
        // 3. API call
        const response = await fetch(getApiEndpoint(actionType), {
            method: 'POST',
            body: JSON.stringify(data),
            headers: getStandardHeaders()
        });
        const result = await response.json();
        
        if (result.success) {
            // 4. Success notification with system context
            showNotification(getSuccessMessage(actionType, result), 'success');
            handleSuccessRedirect(actionType, result);
        } else {
            // 5. Specific error message with system context
            showNotification(getErrorMessage(actionType, result), 'error');
        }
    } catch (error) {
        // 6. Network error handling with system context
        console.error(`${actionType} error:`, error);
        showNotification(getNetworkErrorMessage(actionType), 'error');
    }
}
```

### Enforcement and Code Review:

When reviewing ANY code changes:

1. **Search for browser dialogs**: `grep -r "alert\|confirm\|prompt" resources/views/`
2. **Verify notification inclusion**: Ensure `<x-notification-system />` is present
3. **Check message quality**: Ensure specific, contextual messages
4. **Test user flows**: Verify professional user experience

### Migration Checklist for Existing Code:

- [ ] **Quote System**: Replace all `confirm()` calls with confirmation modals
- [ ] **Trip System**: Verify all operations use modern notifications  
- [ ] **Contact System**: Ensure all CRUD operations use modern feedback
- [ ] **Booking System**: Verify form interactions use modern notifications
- [ ] **Admin System**: Check all administrative functions

### The Rule:

**EVERY user interaction across ALL systems must feel professional and provide clear, helpful feedback. NO browser dialogs anywhere in the application. This applies to quotes, trips, contacts, bookings, admin functions, and any future features.**

## Development Guidelines

- Always start coding on a Feature Branch, NEVER ON MAIN
- Do what has been asked; nothing more, nothing less
- NEVER create files unless they're absolutely necessary for achieving your goal
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User

## CRITICAL: DOCUMENTATION REVIEW REQUIREMENT

**🚨 MANDATORY: ALWAYS READ THE DOCS FOLDER BEFORE MAKING ANY CHANGES**

Before implementing ANY changes to code, you MUST:

1. **Check `/docs/` folder** for existing documentation about the system you're modifying
2. **Read architecture documents** to understand current patterns and approved approaches
3. **Review troubleshooting guides** to avoid known issues and anti-patterns
4. **Follow established patterns** documented in the system architecture

### Key Documentation Files to Check:
- **Email System**: `docs/EMAIL_INTEGRATION_BDD_ANALYSIS.md` and `docs/EMAIL_SYSTEM_ARCHITECTURE.md`
- **Booking Forms**: `docs/BOOKING_FORM_SYSTEM_BDD.md` and `docs/BOOKING_FORM_ARCHITECTURE.md`
- **Special Fields**: `docs/SPECIAL_FIELDS_TROUBLESHOOTING.md`
- **Notifications**: `docs/NOTIFICATION_SYSTEM.md`
- **Any system-specific documentation** in the `/docs/` folder

### The Documentation Rule:
**If documentation exists for a system, follow it exactly. Do NOT invent new patterns or approaches when established ones are documented. The docs folder contains the authoritative architecture decisions and approved implementation patterns.**

### Documentation Search Process:
1. Run `ls docs/` to see what documentation exists
2. Search for relevant files: `grep -r "keyword" docs/` 
3. Read the full documentation before starting implementation
4. Implement following the documented patterns exactly

**NEVER assume how a system works. ALWAYS read the documentation first.**

*Last updated: 2025-09-29 - CI/CD workflows cleaned and optimized*

## Key Services

- `ContactScreenService` - Manages contact form layouts
- `ContactService` - Handles contact CRUD operations
- `TripService` - Manages trip operations
- `ContactValidationService` - Validates contact data
- `form-field-renderer` - Universal field rendering component
- `searchable-select` - Searchable dropdown component
- `FormFieldService` - **CORE CRITICAL** - Aggregates system and custom fields for form builder

## Step-Based UI Pattern (CRITICAL STANDARD)

**USE THIS PATTERN FOR ALL MULTI-STEP WORKFLOWS**

The application uses a standardized step-based UI pattern for complex workflows like Groups setup, Marketing campaigns, and other multi-stage processes. This pattern ensures consistency and usability across all admin functions.

### Pattern Documentation
**Reference**: `/docs/NOTIFICATION_SYSTEM.md` - Contains complete notification system guidelines

### Core Components Required

#### 1. Progress Stepper Component
Use the existing `<x-workflow-stepper>` component whenever possible:

```blade
<!-- Use existing component (preferred) -->
<x-workflow-stepper :currentStep="1" />

<!-- Or implement matching structure -->
<div class="bg-white shadow overflow-hidden sm:rounded-lg mb-6">
    <div class="px-4 py-5 sm:px-6 bg-gray-50">
        <div class="flex items-center justify-between">
            <!-- Step indicators with icons -->
        </div>
        <!-- Progress bar -->
        <div class="mt-4">
            <div class="bg-gray-200 rounded-full h-2">
                <div class="bg-purple-600 h-2 rounded-full" style="width: 25%"></div>
            </div>
        </div>
    </div>
</div>
```

#### 2. Notification System Integration
**MANDATORY**: Include modern notifications on ALL step-based workflows:

```blade
@section('content')
    <x-notification-system />
    <!-- Your step content -->
@endsection
```

### Established Patterns

#### Groups Setup (`/groups/create`)
- **Component**: `<x-workflow-stepper :currentStep="1" />`  
- **Steps**: Group Created → Cabin Pricing → Checkpoints → Booking Forms
- **Icons**: Each step has a meaningful SVG icon
- **Colors**: Green (completed) → Purple (active) → Gray (pending)

#### Marketing Campaigns (`/admin/marketing/campaigns/create`)
- **Component**: Custom implementation matching workflow-stepper
- **Steps**: Campaign Creation → List Selection → Email Creation → Review & Schedule
- **Icons**: Checkmark, list, email, document icons
- **Enhanced Features**: Search, checkboxes, pagination in List Selection

### Implementation Requirements

#### 1. Visual Consistency
- **Container**: White background with shadow (`bg-white shadow overflow-hidden sm:rounded-lg`)
- **Header**: Gray background (`bg-gray-50`) with padding (`px-4 py-5 sm:px-6`)
- **Layout**: Horizontal step indicators with labels beside icons
- **Progress Bar**: Purple bar (`bg-purple-600`) below step indicators

#### 2. Color Standards
```css
/* Completed Steps */
.completed {
    background: bg-green-100;
    color: text-green-600;
    icon: checkmark;
}

/* Active Step */
.active {
    background: bg-purple-100;
    color: text-purple-600;
    icon: checkmark or step-specific;
}

/* Pending Steps */
.pending {
    background: bg-gray-200;
    color: text-gray-400;
    icon: step-specific;
}
```

#### 3. JavaScript Requirements
```javascript
// Standard step management functions
function changeStep(direction) {
    // Validate current step
    if (direction > 0 && !validateStep(currentStep)) return;
    
    // Update indicators
    updateStepIndicator(currentStep, direction > 0 ? 'completed' : 'pending');
    
    // Show/hide step content
    // Update navigation buttons
    // Update progress bar
}

function updateStepIndicator(step, status) {
    // Update circle background and icon
    // Update text color
    // Update progress bar width
}

function validateStep(step) {
    // Step-specific validation
    // Show notifications for errors
    return valid;
}
```

#### 4. Navigation Standards
- **Previous Button**: Gray, hidden on first step
- **Next Button**: Purple, validate before proceeding
- **Submit Button**: Purple, only on final step
- **Progress Bar**: Animated width updates

### Common Step Types and Patterns

#### Information Collection Steps
- **Form validation** before proceeding
- **Clear field labels** and helpful text
- **Error notifications** for missing required fields

#### Selection Steps (like List Selection)
- **Preview functionality** for complex selections
- **Search and filter** capabilities
- **Bulk operations** with checkboxes
- **Real-time counts** and feedback

#### Review Steps
- **Summary of all previous choices**
- **Edit links** to return to specific steps
- **Final validation** before submission
- **Clear call-to-action** buttons

### Advanced Features (When Appropriate)

#### Enhanced List Management
```javascript
// Full list view with search
function toggleFullList() {
    isFullListView = !isFullListView;
    loadContacts(currentPage, currentSearch);
}

// Contact exclusion with checkboxes
function toggleContactSelection(contactId) {
    // Visual feedback for excluded items
    // Update recipient counts
}

// Pagination for large datasets
function renderPagination(pagination) {
    // Page controls with proper styling
}
```

#### Save and Resume Functionality
- **Auto-save** progress to prevent data loss
- **Named lists** or configurations for reuse
- **Draft state** management

### Error Handling Standards

#### Validation Errors
```javascript
// Use notifications, not alerts
showNotification('Please complete all required fields', 'error');

// Highlight problem areas
document.getElementById('fieldName').classList.add('border-red-500');
```

#### Network Errors
```javascript
.catch(error => {
    console.error('Step error:', error);
    showNotification('Network error. Please check your connection.', 'error');
});
```

#### User Guidance
```javascript
// Helpful progress messages
showNotification('Validating recipient list...', 'info');
showNotification('Campaign created successfully!', 'success');
```

### Implementation Checklist

When creating ANY new step-based workflow:

- [ ] **Include notification system** (`<x-notification-system />`)
- [ ] **Use workflow-stepper component** or implement matching structure
- [ ] **Follow color standards** (green/purple/gray)
- [ ] **Implement step validation** with helpful error messages
- [ ] **Add progress bar** with animated updates
- [ ] **Use proper icons** for each step type
- [ ] **Include navigation controls** (prev/next/submit buttons)
- [ ] **Handle edge cases** (network errors, validation failures)
- [ ] **Test on mobile** (responsive design)
- [ ] **Document any custom patterns** for future use

### The Rule for Step-Based UI

**Every multi-step workflow must use this standardized pattern. No custom implementations without documentation justification. Consistency is critical for user experience and maintainability.**

## Booking Form System (CORE CRITICAL)

**⚠️ WARNING: This system is CORE CRITICAL to the application's multi-tenant value proposition.**

The Booking Form System enables tenants to create custom booking forms combining system fields with tenant-specific custom fields. ANY changes to this system must be made with extreme care and comprehensive testing.

### Critical Documentation:
- **BDD Specification**: `docs/BOOKING_FORM_SYSTEM_BDD.md`
- **Technical Architecture**: `docs/BOOKING_FORM_ARCHITECTURE.md`  
- **Troubleshooting Playbook**: `docs/BOOKING_FORM_TROUBLESHOOTING.md`
- **Test Scenarios**: `docs/BOOKING_FORM_TEST_SCENARIOS.md`

### Core Components:
- `FormFieldService` - Aggregates all available fields from multiple sources
- `BookingFormController` - Handles form CRUD operations
- Three critical views that MUST stay synchronized:
  1. Admin Edit Preview (`admin/booking-forms/{id}/edit`)
  2. Admin Form View (`admin/booking-forms/{id}`)
  3. Public Booking Form (`booking-forms/{slug}`)

### Critical Rules:
1. **View Synchronization**: Any form rendering changes must be applied to ALL three views
2. **Field Filtering**: All views must use identical problematic section and field deduplication logic
3. **Field Type Support**: All views must handle ALL field types with proper rendering
4. **Custom Field Integration**: System must properly merge tenant custom fields with system fields
5. **CRITICAL Field Data Structure**: Every field MUST have both `type` AND `field_type` properties for form-field-renderer component to work

### Common Critical Issues:
- **Duplicate Sections**: Form shows 6 sections instead of 3 (legacy test data mixed with production)
- **Wrong Field Types**: Multi-select shows as text input (missing case handler)  
- **Missing Custom Fields**: Custom fields don't appear (service integration issues)
- **View Inconsistency**: Different views show different fields (unsynchronized filtering logic)
- **CRITICAL: Module Fields as Text Inputs**: Complex fields render as text inputs when missing `field_type` property

### Emergency Response:
If the booking form system becomes unusable, this impacts ALL tenants' ability to collect custom data. Treat as highest priority incident and refer to troubleshooting playbook immediately.

## Field Types

- `affiliate_clubs` - Creates cascading affiliate group → affiliate dropdowns
- `cruise_rewards` - Cruise line loyalty program fields
- `multi_select` - Multiple checkbox selections
- `searchable_select` - Large option lists with search

### ⚠️ CRITICAL: Special Fields Documentation

**The `affiliate_clubs` and `cruise_rewards` fields frequently break. See `/docs/SPECIAL_FIELDS_TROUBLESHOOTING.md` for comprehensive documentation.**

Quick fixes for common issues:
1. **Fields showing as text inputs**: Check both `$field['field_type'] ?? $field['type']` 
2. **Validation errors**: Ensure affiliate_clubs sends single value, not array
3. **Empty dropdowns in embeds**: Set tenant context with `session(['tenant_id' => $form->tenant_id])`
4. **JavaScript errors**: Define functions globally for AJAX-loaded content

**ALWAYS TEST IN ALL 4 CONTEXTS**: Contact edit, Public form, Embed form, Admin preview

## Testing Requirements (CRITICAL)

**MANDATORY TEST CASE UPDATES**

Whenever you add or edit ANY code in this repository, you MUST:

1. **Create test cases** for new functionality
2. **Update existing test cases** when modifying functionality  
3. **Never leave functionality untested**

### Test Coverage Requirements:
- **Authentication**: All login flows, password setup, verification codes
- **Contact Management**: Creation, editing, validation, custom fields
- **Trip Management**: Individual and Group trip creation/editing
- **Group Management**: Cruise group creation and editing
- **Document Management**: Upload, removal, association
- **Task Management**: Creation, updates, removal
- **Tenant Isolation**: Cross-tenant data protection

### Test Organization:
- Feature tests in `tests/Feature/`
- Unit tests in `tests/Unit/`  
- All backed up test cases in `tests/backup_test_cases/`

### The Rule:
**If you write code, you write tests. If you edit code, you update tests. No exceptions.**

This mandate exists because production issues were allowed to reach customers due to inadequate test coverage. Every function must be tested to prevent regressions.

## Test Writing Standards (CRITICAL)

**HUNDREDS OF TESTS WERE BROKEN DUE TO POOR TEST QUALITY. NEVER REPEAT THESE MISTAKES.**

### MANDATORY PRE-TEST CHECKLIST

Before writing ANY test case, you MUST complete this checklist:

1. **Read the migration file** - Verify actual table schema, field names, and constraints
2. **Check model's $fillable array** - Understand valid fields and relationships
3. **Test factory independently** - Run `Model::factory()->create()` to ensure it works
4. **Copy existing patterns** - Find working tests for similar models and copy the approach
5. **Verify business logic** - Understand computed vs stored properties

### NEVER DO THESE THINGS:

- ❌ **Assume field names** without checking migrations (trigger_event vs trigger_type)
- ❌ **Add tenant_id to global reference data** (cruise_lines, cruise_ships, ports, rewards_programs are GLOBAL)
- ❌ **Use hardcoded field arrays** instead of factory methods
- ❌ **Test computed properties as stored values** (e.g., 'overdue' status is computed, not stored)
- ❌ **Invent new patterns** when working ones exist
- ❌ **Create factories out of sync with database schema**

### CRITICAL DATA ARCHITECTURE RULES:

**Global Reference Data (NO tenant_id):**
- `cruise_lines` - Global shipping company data
- `cruise_ships` - Global vessel data  
- `ports` - Global port location data
- `rewards_programs` - Global loyalty program data

**Tenant-Scoped Data (HAS tenant_id):**
- `contacts` - Customer data per tenant
- `trips` - Bookings per tenant
- `checkpoints` - Custom workflows per tenant
- `checkpoint_items` - Form fields per tenant

**Computed vs Stored Status:**
- ✅ Status stored in database: `'pending'`, `'completed'`, `'skipped'`, `'expired'`
- ❌ Status NOT stored: `'overdue'` (computed from pending + past due_date)
- Use: `$assignment->isOverdue()` method or `TripCheckpointAssignment::factory()->overdue()`

### PROPER TEST PATTERNS:

```php
// CORRECT: Use factory defaults
$cruiseLine = CruiseLine::factory()->create(['name' => 'Royal Caribbean']);

// CORRECT: No tenant_id for global data
$cruiseShip = CruiseShip::factory()->create([
    'cruise_line_id' => $cruiseLine->id,
    'name' => 'Symphony of the Seas'
]);

// CORRECT: Use factory state methods for complex scenarios
$assignment = TripCheckpointAssignment::factory()->overdue()->create([
    'trip_id' => $trip->id,
    'checkpoint_id' => $checkpoint->id
]);

// CORRECT: Test what's actually stored, not computed values
$this->assertEquals('pending', $assignment->status); // ✅ Stored value
$this->assertTrue($assignment->isOverdue()); // ✅ Computed property
```

### THE GOLDEN RULE:

**If a factory or test fails due to schema mismatch, the problem is the test, not the production code. Fix the test to match reality.**

Production code and database migrations are the source of truth. Tests must conform to them, not the other way around.

## Technical Debt Management (Opportunistic Refactoring)

**Code Quality Status: 7.5/10** - Strong architectural foundations with manageable technical debt.

**Refactoring Strategy: Gradual improvement during natural feature development**

When working on features, gradually improve code quality using these prioritized approaches:

### 1. Extract Blade Template Partials ✅ **LOWEST RISK**
When fixing bugs or adding features to large Blade templates:
- Extract header sections, tab content, and repeated UI blocks into `partials/` directory
- **Target files**: trips/show.blade.php (2,680 lines), trips/create.blade.php (1,389 lines)
- **Risk**: Virtually zero - pure template reorganization
- **Benefit**: Immediate readability improvement, easier maintenance

### 2. Create Focused JavaScript Components ⚠️ **MEDIUM RISK**  
When adding new JavaScript features:
- Create new focused components instead of extending large existing ones
- **Target files**: TripManager.js (930 lines), ScreenBuilder.js (831 lines), FormBuilder.js (731 lines)
- **Risk**: Medium - DOM manipulation complexity, testing required
- **Benefit**: Better component isolation, easier debugging

### 3. Extract Controller Methods ⚠️ **HIGHER RISK**
When touching controller methods for features:
- Extract related methods into focused controllers (e.g., ContactArchiveController)
- **Target files**: ContactController (1,440 lines), GroupController (1,008 lines)  
- **Risk**: Higher - complex business logic, extensive testing required
- **Benefit**: Better separation of concerns, smaller focused classes

### Guidelines:
- **Start with #1** (Blade partials) - safest wins with immediate impact
- **Never do major refactoring** during active feature development
- **Opportunistic only** - improve what you're naturally touching
- **Maintain excellent test coverage** during any changes
- **Priority**: Feature delivery > technical debt reduction