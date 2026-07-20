-- Sample issue matching the original Ebb & Flow design mock.
-- Safe to re-run: uses fixed UUIDs and upserts.

INSERT INTO subscribers (id, email, first_name, status)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'editor@example.com', 'Alex', 'active'),
  ('22222222-2222-2222-2222-222222222222', 'neighbor@example.com', NULL, 'active')
ON CONFLICT (email) DO UPDATE
SET first_name = EXCLUDED.first_name,
    status = EXCLUDED.status,
    updated_at = now();

INSERT INTO issues (
  id, issue_date, volume_label, subject, preheader, intro,
  weather, high_tides, low_tides, high_tide_label, coming_up,
  cta_url, cta_label, tip_headline, tip_body, postal_address, status
) VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '2026-07-19',
  'Vol. 4, No. 29',
  'The Ebb & Flow — July 19, 2026',
  'This week: the council''s $14M budget vote, the Elm Street bridge reopening, and Friday''s farmers market returns to Main Plaza.',
  'Six stories worth your time this week — from a contentious budget vote at Town Hall to the return of the Friday market. Here''s the roundup.',
  '54°F · Light Rain',
  '6:12a · 5:48p',
  '12:03p · 11:41p',
  'High tide 6:12 a.m.',
  ARRAY[
    'The parade route for the Little League send-off',
    'A first look inside the renovated Corner Cafe',
    'School board''s vote on the new bus schedule'
  ],
  'https://example.com',
  'Read the full stories →',
  'Got a tip or a story we missed?',
  'Just hit reply — every message reaches the newsroom directly.',
  '123 Main Street, Suite 4 · Your Town, ST 00000',
  'ready'
)
ON CONFLICT (id) DO UPDATE SET
  issue_date = EXCLUDED.issue_date,
  volume_label = EXCLUDED.volume_label,
  subject = EXCLUDED.subject,
  preheader = EXCLUDED.preheader,
  intro = EXCLUDED.intro,
  weather = EXCLUDED.weather,
  high_tides = EXCLUDED.high_tides,
  low_tides = EXCLUDED.low_tides,
  high_tide_label = EXCLUDED.high_tide_label,
  coming_up = EXCLUDED.coming_up,
  cta_url = EXCLUDED.cta_url,
  cta_label = EXCLUDED.cta_label,
  tip_headline = EXCLUDED.tip_headline,
  tip_body = EXCLUDED.tip_body,
  postal_address = EXCLUDED.postal_address,
  status = EXCLUDED.status,
  updated_at = now();

DELETE FROM stories WHERE issue_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

INSERT INTO stories (
  issue_id, position, toc_title, title, eyebrow, summary, why_it_matters,
  url, image_url, quote, quote_attribution
) VALUES
(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1,
  'Council approves $14M budget',
  'Council approves $14M budget after four-hour debate',
  'Lead Story · Local Government',
  'The narrow 4–3 vote raises the parks levy but spares the library from cuts. Residents packed the chamber until nearly midnight, with more than 40 signed up to speak.',
  'Your property tax bill won''t change this year, but park fees will.',
  'https://example.com/budget-vote',
  'https://placehold.co/1040x440/e7e1d6/8a7f6d?text=Lead+photo',
  'This budget keeps the lights on at the library. That was the line we would not cross.',
  'Mayor Dana Reyes'
),
(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 2,
  'Elm Street bridge to reopen',
  'Elm Street bridge on track to reopen by Labor Day',
  'Infrastructure · Reopens Sept 1',
  'Crews finished the deck pour last week. The county says weekend detours will lift once striping is complete.',
  'The Riverside detour that''s added 15 minutes to your commute ends soon.',
  'https://example.com/bridge', NULL, NULL, NULL
),
(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 3,
  'Friday farmers market returns',
  'Friday farmers market returns to Main Plaza this week',
  'Community · Fri, 3–8 p.m.',
  'Twenty-two vendors are confirmed, including two new bakers. Live music runs 5–8 p.m. through September.',
  'Free parking behind the plaza is back for market days.',
  'https://example.com/market', NULL, NULL, NULL
),
(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 4,
  'District hires 12 new teachers',
  'District hires 12 new teachers ahead of fall term',
  'Schools',
  'The additions fill long-vacant math and special-education roles. Orientation begins the second week of August.',
  'Class sizes at the two elementary schools should shrink this year.',
  'https://example.com/schools', NULL, NULL, NULL
),
(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 5,
  'Corner Cafe reopens',
  'Corner Cafe reopens under new owners after renovation',
  'Business · Opens Thu',
  'The 40-year-old diner kept its counter and its pie recipes. A soft opening starts Thursday.',
  'A beloved downtown gathering spot is back after 8 months dark.',
  'https://example.com/cafe', NULL, NULL, NULL
),
(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 6,
  'Little League clinches title',
  'Regional Little League team clinches division title',
  'Sports',
  'A walk-off double in the seventh sent the squad to state. Send-off parade details to follow next week.',
  'First state berth for the town in over a decade.',
  'https://example.com/sports', NULL, NULL, NULL
);

INSERT INTO tasks (id, title, notes, status, due_date, issue_id)
VALUES
  (
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
    'Confirm weather & tides',
    'Pull morning readings before send.',
    'todo',
    '2026-07-19',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  ),
  (
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2',
    'Proof lead story quote',
    'Check attribution spelling.',
    'doing',
    '2026-07-19',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  )
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  notes = EXCLUDED.notes,
  status = EXCLUDED.status,
  due_date = EXCLUDED.due_date,
  issue_id = EXCLUDED.issue_id,
  updated_at = now();

-- Unused transcripts for Claude auto-draft demos (newest recorded_at wins).
INSERT INTO transcripts (id, title, content, source, speaker, recorded_at)
VALUES
  (
    'dddddddd-dddd-dddd-dddd-ddddddddddd1',
    'Harbor commission work session',
    E'SPEAKER: Harbor Master Eli Stone\nWe''re pushing the fuel dock repair another week. The parts boat is delayed out of Seattle, so commercial boats should plan to top off in Ward Cove until further notice.\n\nSPEAKER: Commissioner Lane\nCan we put a notice at the ramp and email the fleet list tonight?\n\nSPEAKER: Harbor Master Eli Stone\nYes. Notice goes up today. I''ll send the fleet email before 5.',
    'Harbor Commission',
    'Eli Stone',
    now() - interval '3 hours'
  ),
  (
    'dddddddd-dddd-dddd-dddd-ddddddddddd2',
    'Library board meeting',
    E'SPEAKER: Board Chair Maya Ortiz\nMotion to pause late fees through September. All in favor?\n[Vote passes 5–0]\n\nSPEAKER: Staff librarian\nReturns are already up this week. Families are bringing bags of books back.\n\nSPEAKER: Board Chair Maya Ortiz\nCall it a summer reset. We''ll revisit fees in October.',
    'Library Board',
    'Maya Ortiz',
    now() - interval '2 hours'
  ),
  (
    'dddddddd-dddd-dddd-dddd-ddddddddddd3',
    'Tourism desk standup',
    E'SPEAKER: Ops lead\nTwo ships Thursday, one Friday. Downtown shuttle loop extends to 8 p.m. on ship days only.\n\nSPEAKER: Downtown liaison\nGangway times look clean. We''ll post the map boards by noon Wednesday.',
    'Tourism Desk',
    '',
    now() - interval '45 minutes'
  )
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  content = EXCLUDED.content,
  source = EXCLUDED.source,
  speaker = EXCLUDED.speaker,
  recorded_at = EXCLUDED.recorded_at;

-- Unused findings (fallback when no transcripts are available).
INSERT INTO findings (id, title, body, source_url, category, found_at)
VALUES
  (
    'cccccccc-cccc-cccc-cccc-ccccccccccc1',
    'Harbor fuel dock delay',
    'Harbor master says the fuel dock repair slips another week. Commercial boats are topping off in Ward Cove instead. Quote pending from Harbor Master Eli Stone.',
    'https://example.com/harbor',
    'Waterfront',
    now() - interval '2 hours'
  ),
  (
    'cccccccc-cccc-cccc-cccc-ccccccccccc2',
    'Library late fees pause',
    'City library board voted to pause late fees through September. Staff say returns are already up. Board chair called it a summer reset for families.',
    'https://example.com/library',
    'Community',
    now() - interval '1 hour'
  ),
  (
    'cccccccc-cccc-cccc-cccc-ccccccccccc3',
    'Cruise gangway schedule',
    'Two ships Thursday, one Friday. Downtown shuttle loop extends to 8 p.m. on ship days only.',
    'https://example.com/cruise',
    'Tourism',
    now() - interval '30 minutes'
  )
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  body = EXCLUDED.body,
  source_url = EXCLUDED.source_url,
  category = EXCLUDED.category,
  found_at = EXCLUDED.found_at;
