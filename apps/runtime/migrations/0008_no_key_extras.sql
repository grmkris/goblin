-- 0007 already ran on dev. Finish retiring `keys` without changing an applied migration (ADR 0126).
-- Preserve every other extra, field, reach and installation; malformed JSON stays unreadable.
update "grant"
set "extras" = (select json_group_array(value) from json_each("grant"."extras") where value IS NOT 'keys')
where json_type(case when json_valid("extras") then "extras" else '[]' end) = 'array'
  and exists (select 1 from json_each(case when json_valid("extras") then "extras" else '[]' end) where value = 'keys');

update "app"
set "terms" = json_set("terms", '$.extras', json((select json_group_array(value) from json_each("app"."terms", '$.extras') where value IS NOT 'keys')))
where json_type(case when json_valid("terms") then "terms" else '{}' end, '$.extras') = 'array'
  and exists (select 1 from json_each(case when json_valid("terms") then "terms" else '{}' end, '$.extras') where value = 'keys');
