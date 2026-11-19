-- NOTE-001 follow-up defense in depth. The three message-template engines
-- historically allowed auth.uid() IS NULL for server-side service-role
-- maintenance. Keep trusted service-role and direct postgres migrations,
-- but reject an authenticated SQL session with no verified actor identity,
-- even if it reaches the non-exposed private routine through a SQL channel.
-- Public facade auth guards are NOT relied upon as the only authorization.
DO $internal_template_auth$
DECLARE
  rec record;
  v_definition text;
  v_needle text :=
    'if auth.uid() is not null and not public.is_account_member(p_account_id, ''admin''::public.account_role_enum) then';
  v_guard text :=
    'if auth.uid() is null' || E'\n' ||
    '     and coalesce(auth.role(), '''') <> ''service_role''' || E'\n' ||
    '     and session_user <> ''postgres'' then' || E'\n' ||
    '    raise exception ''MESSAGE_TEMPLATE_AUTH_REQUIRED'' using errcode = ''42501'';' || E'\n' ||
    '  end if;' || E'\n  ';
  v_count integer:=0;
BEGIN
  FOR rec IN
    SELECT p.oid,p.proname,p.prosecdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='wacrm_internal' AND p.proname=ANY(ARRAY[
      'create_message_template_revision',
      'publish_message_template_revision',
      'unpublish_message_template'
    ])
  LOOP
    IF NOT rec.prosecdef THEN
      RAISE EXCEPTION 'Expected internal definer for %',rec.proname;
    END IF;
    v_definition:=pg_get_functiondef(rec.oid);
    IF strpos(v_definition,v_needle)=0 THEN
      RAISE EXCEPTION 'Message-template authorization code changed: %',rec.proname;
    END IF;
    EXECUTE replace(v_definition,v_needle,v_guard || v_needle);
    v_count:=v_count+1;
  END LOOP;
  IF v_count<>3 THEN
    RAISE EXCEPTION 'Expected 3 private message-template engines, found %',v_count;
  END IF;
END $internal_template_auth$;
