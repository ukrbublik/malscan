--
-- PostgreSQL database dump
--

-- Dumped from database version 9.5.5
-- Dumped by pg_dump version 9.5.5

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: plpgsql; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS plpgsql WITH SCHEMA pg_catalog;


--
-- Name: EXTENSION plpgsql; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION plpgsql IS 'PL/pgSQL procedural language';


--
-- Name: intarray; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS intarray WITH SCHEMA public;


--
-- Name: EXTENSION intarray; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION intarray IS 'functions, operators, and index support for 1-D arrays of integers';


SET search_path = public, pg_catalog;

--
-- Name: malrec_dataset_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE malrec_dataset_type AS ENUM (
    'train',
    'validate',
    'test'
);


--
-- Name: malrec_gender; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE malrec_gender AS ENUM (
    'Male',
    'Female',
    'Non-Binary'
);


--
-- Name: malrec_item_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE malrec_item_type AS ENUM (
    'TV',
    'Movie',
    'Special',
    'OVA',
    'ONA'
);


--
-- Name: malrec_items_rel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE malrec_items_rel AS ENUM (
    'Prequel',
    'Sequel',
    'Other',
    'Side story',
    'Parent story',
    'Alternative version',
    'Spin-off',
    'Summary',
    'Full story',
    'Alternative setting',
    'Character'
);


--
-- Name: malrec_ratings_row; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE malrec_ratings_row AS (
	user_list_id integer,
	item_id integer,
	rating integer
);


--
-- Name: malrec_set_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE malrec_set_type AS ENUM (
    'train',
    'validate',
    'test'
);


--
-- Name: decr_ratings_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION decr_ratings_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 update malrec_items
  set ratings_count = ratings_count - 1
  where id = OLD.item_id;
 update malrec_users
  set ratings_count = ratings_count - 1
  where list_id = OLD.user_list_id;
 
 RETURN NEW;
END;
$$;


--
-- Name: incr_ratings_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION incr_ratings_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 update malrec_items
  set ratings_count = ratings_count + 1
  where id = NEW.item_id;
 update malrec_users
  set ratings_count = ratings_count + 1
  where list_id = NEW.user_list_id;
 
 RETURN NEW;
END;
$$;


--
-- Name: malrec_add_rating_for_user_id(integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION malrec_add_rating_for_user_id(_user_id integer, _item_id integer, _rating integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE _user_list_id integer;
BEGIN
	select list_id
	 into _user_list_id
	 from malrec_users
	 where id = _user_id;

	if _user_list_id is null then
		_user_list_id = nextval('malrec_users_list_id_seq'::regclass);
		update malrec_users
		set list_id = _user_list_id
		where id = _user_id;
	end if;	

	insert into malrec_ratings (
		user_list_id,
		item_id,
		rating
	) select 
		_user_list_id,
		_item_id,
		_rating;

	update malrec_users
	 set are_ratings_modified = true
	 where list_id = _user_list_id and are_ratings_modified = false;
	update malrec_items
	 set are_ratings_modified = true
	 where id = _item_id and are_ratings_modified = false;

	RETURN 0;
END;
$$;


--
-- Name: malrec_add_ratings_rand(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION malrec_add_ratings_rand() RETURNS void
    LANGUAGE plpgsql
    AS $$
  DECLARE column_rand character varying;
  BEGIN
    SELECT column_name into column_rand
    FROM information_schema.columns 
    WHERE table_name='malrec_ratings' and column_name='rand';
    if column_rand = 'rand' then
    else
      alter table malrec_ratings add column rand integer;
      CREATE INDEX malrec_ratings_rand_id_indx ON malrec_ratings USING btree (rand, id);
    end if;
  END;
  $$;


--
-- Name: malrec_delete_all_data(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION malrec_delete_all_data() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN

delete from malrec_ratings;
delete from malrec_users;
delete from malrec_items_rels;
delete from malrec_items_recs;
delete from malrec_items;
delete from malrec_genres;

ALTER SEQUENCE malrec_users_list_id_seq RESTART WITH 1;
ALTER SEQUENCE malrec_items_franchise_id_seq RESTART WITH 1;

END;
$$;


--
-- Name: malrec_drop_ratings_rand(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION malrec_drop_ratings_rand() RETURNS void
    LANGUAGE plpgsql
    AS $$
  BEGIN
    alter table malrec_ratings drop column if exists rand;
  END;
  $$;


--
-- Name: malrec_fix_for_train(boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION malrec_fix_for_train(_use_all_for_train boolean) RETURNS integer
    LANGUAGE plpgsql
    AS $$BEGIN
	if _use_all_for_train = true then
		-- mark all U/I as unmodified and used for train
		update malrec_items
		 set is_used_for_train = true
		 where is_used_for_train = false;
		update malrec_users
		 set is_used_for_train = true
		 where is_used_for_train = false;

		update malrec_items
		 set are_ratings_modified = false
		 where are_ratings_modified = true;
		update malrec_users
		 set are_ratings_modified = false
		 where are_ratings_modified = true;
	else
		-- mark modified U/I as used for train
		update malrec_items
		 set is_used_for_train = false
		 where is_used_for_train = true;
		update malrec_users
		 set is_used_for_train = false
		 where is_used_for_train = true;

		update malrec_items
		 set is_used_for_train = true, are_ratings_modified = false
		 where are_ratings_modified = true;
		update malrec_users
		 set is_used_for_train = true, are_ratings_modified = false
		 where are_ratings_modified = true;
	end if;
	
	-- apply changes to ratings
	update malrec_ratings
	 set rating = new_rating, new_rating = null
	 where new_rating is not null;

	delete from malrec_ratings
	 where rating = 0;

	update malrec_ratings
	 set dataset_type = 0
	 where dataset_type = 4;

	RETURN 0;
END;
$$;


--
-- Name: malrec_import_ml_100k(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION malrec_import_ml_100k(_path text) RETURNS integer[]
    LANGUAGE plpgsql
    AS $$
DECLARE imported_users integer;
DECLARE imported_items integer;
DECLARE imported_ratings integer;
DECLARE rec RECORD;
BEGIN

-- clear all data
delete from malrec_ratings;
delete from malrec_users;
delete from malrec_items;
ALTER SEQUENCE malrec_users_list_id_seq RESTART WITH 1;
drop table if exists input_tmp;

-- import from u.user
create temporary table input_tmp (
	user_id integer,
	age integer,
	gender text,
	occupation text,
	zip_code text
);
EXECUTE ('COPY input_tmp (
	user_id,
	age,
	gender,
	occupation,
	zip_code
)
FROM ' || QUOTE_LITERAL(_path || '/u.user') || ' DELIMITER ''|'' CSV ');

INSERT INTO malrec_users (
	id
)
SELECT
	user_id
FROM input_tmp;

SELECT COUNT(*)
	INTO imported_users
	FROM input_tmp;

drop table input_tmp;

-- import from u.item
create temporary table input_tmp (
	movie_id integer,
	movie_title text,
	release_date text,
	video_release_date text,
	IMDb_URL text,
	_unknown text,
	genre_Action integer,
	genre_Adventure integer,
	genre_Animation integer,
	genre_Children integer,
	genre_Comedy integer,
	genre_Crime integer,
	genre_Documentary integer,
	genre_Drama integer,
	genre_Fantasy integer,
	genre_Film_Noir integer,
	genre_Horror integer,
	genre_Musical integer,
	genre_Mystery integer,
	genre_Romance integer,
	genre_Sci_Fi integer,
	genre_Thriller integer,
	genre_War integer,
	genre_Western integer
);
EXECUTE ('COPY input_tmp (
	movie_id,
	movie_title,
	release_date,
	video_release_date,
	IMDb_URL,
	_unknown,
	genre_Action,
	genre_Adventure,
	genre_Animation,
	genre_Children,
	genre_Comedy,
	genre_Crime,
	genre_Documentary,
	genre_Drama,
	genre_Fantasy,
	genre_Film_Noir,
	genre_Horror,
	genre_Musical,
	genre_Mystery,
	genre_Romance,
	genre_Sci_Fi,
	genre_Thriller,
	genre_War,
	genre_Western
)
FROM ' || QUOTE_LITERAL(_path || '/u.item') || ' DELIMITER ''|'' CSV encoding ''windows-1251'' ');

INSERT INTO malrec_items (
	id,
	name
)
SELECT
	movie_id,
	movie_title::character varying(1000)
FROM input_tmp;

SELECT COUNT(*)
	INTO imported_items
	FROM input_tmp;

drop table input_tmp;

-- import from u.data
create temporary table input_tmp (
	user_id integer,
	item_id integer,
	rating integer,
	timestamp integer
);
EXECUTE ('COPY input_tmp (
	user_id,
	item_id,
	rating,
	timestamp
)
FROM ' || QUOTE_LITERAL(_path || '/u.data') || ' DELIMITER E''\t'' CSV ');

FOR rec IN SELECT * FROM input_tmp LOOP
	perform malrec_add_rating_for_user_id(rec.user_id, rec.item_id, rec.rating);
END LOOP;

SELECT COUNT(*)
	INTO imported_ratings
	FROM input_tmp;

drop table input_tmp;


RETURN ARRAY[imported_users, imported_items, imported_ratings];

END;
$$;


--
-- Name: malrec_import_ml_1m(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION malrec_import_ml_1m(_path text) RETURNS integer[]
    LANGUAGE plpgsql
    AS $$
DECLARE imported_users integer;
DECLARE imported_items integer;
DECLARE imported_ratings integer;
DECLARE rec RECORD;
BEGIN

-- clear all data
delete from malrec_ratings;
delete from malrec_users;
delete from malrec_items;
ALTER SEQUENCE malrec_users_list_id_seq RESTART WITH 1;
drop table if exists input_tmp;

-- import from u.user
create temporary table input_tmp (
	user_id integer,
	age integer,
	gender text,
	occupation text,
	zip_code text
);

EXECUTE ('COPY input_tmp (
	user_id,
	gender,
	age,
	occupation,
	zip_code
)
FROM ' || QUOTE_LITERAL(_path || '/users.dat') || ' DELIMITER ''~'' CSV encoding ''windows-1251'' ');

INSERT INTO malrec_users (
	id
)
SELECT
	user_id
FROM input_tmp;

SELECT COUNT(*)
	INTO imported_users
	FROM input_tmp;

drop table input_tmp;

-- import from u.item
create temporary table input_tmp (
	movie_id integer,
	movie_title text,
	genres text
);
EXECUTE ('COPY input_tmp (
	movie_id,
	movie_title,
	genres
)
FROM ' || QUOTE_LITERAL(_path || '/movies.dat') || ' DELIMITER ''~'' CSV ');

INSERT INTO malrec_items (
	id,
	name
)
SELECT
	movie_id,
	movie_title::character varying(1000)
FROM input_tmp;

SELECT COUNT(*)
	INTO imported_items
	FROM input_tmp;

drop table input_tmp;

-- import from u.data
create temporary table input_tmp (
	user_id integer,
	item_id integer,
	rating integer,
	timestamp integer
);
EXECUTE ('COPY input_tmp (
	user_id,
	item_id,
	rating,
	timestamp
)
FROM ' || QUOTE_LITERAL(_path || '/ratings.dat') || ' DELIMITER ''~'' CSV ');

FOR rec IN SELECT * FROM input_tmp LOOP
	perform malrec_add_rating_for_user_id(rec.user_id::integer, rec.item_id::integer, rec.rating::integer);
END LOOP;

SELECT COUNT(*)
	INTO imported_ratings
	FROM input_tmp;

drop table input_tmp;


RETURN ARRAY[imported_users, imported_items, imported_ratings];

END;
$$;


--
-- Name: malrec_resplit_to_sets(integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION malrec_resplit_to_sets(_train_pct integer, _validate_pct integer, _test_pct integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE cnt integer;
DECLARE l integer;
DECLARE i1 integer;
DECLARE i2 integer;
DECLARE cur_rats CURSOR FOR 
	SELECT user_list_id, array_agg(item_id ORDER BY RANDOM()) as item_ids 
	FROM malrec_ratings 
	WHERE dataset_type <> 4
	GROUP BY user_list_id
	ORDER BY user_list_id;
DECLARE rec_rat RECORD;
BEGIN
	UPDATE malrec_ratings
	 SET dataset_type = 0
	WHERE dataset_type IN(1,2,3);
	
	cnt = 0;
	OPEN cur_rats;
	LOOP
		FETCH cur_rats INTO rec_rat;
		EXIT WHEN NOT FOUND;
		l = array_length(rec_rat.item_ids, 1);
		i1 = ceil(1.0 * _train_pct / 100  * l);
		i2 = ceil(1.0 * (_train_pct + _validate_pct) / 100 * l);
		UPDATE malrec_ratings
		 SET dataset_type = (CASE 
		  WHEN item_id = ANY( rec_rat.item_ids[ 1 : i1 ] ) THEN 1
		  WHEN item_id = ANY( rec_rat.item_ids[ i1+1 : i2 ] ) THEN 2
		  ELSE 3
		  END)
		 WHERE user_list_id = rec_rat.user_list_id AND dataset_type <> 4;
	END LOOP;
	CLOSE cur_rats;

	RETURN cnt;
END;
$$;


--
-- Name: malrec_split_more_to_sets(integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION malrec_split_more_to_sets(_train_pct integer, _validate_pct integer, _test_pct integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE cnt integer;
DECLARE l integer;
DECLARE i1 integer;
DECLARE i2 integer;
DECLARE cur_rats CURSOR FOR 
	SELECT r.user_list_id, 
		array_agg(r.item_id ORDER BY RANDOM()) filter (where dataset_type = 0) as item_ids,
		count(*) filter (where dataset_type = 1) as train_cnt,
		count(*) filter (where dataset_type = 2) as validate_cnt,
		count(*) filter (where dataset_type = 3) as test_cnt
	FROM malrec_users as u
	INNER JOIN malrec_ratings as r ON r.user_list_id = u.list_id
	WHERE u.is_used_for_train = true AND r.dataset_type <> 4
	GROUP BY r.user_list_id
	ORDER BY r.user_list_id;
DECLARE rec_rat RECORD;
BEGIN
	OPEN cur_rats;
	LOOP
		FETCH cur_rats INTO rec_rat;
		EXIT WHEN NOT FOUND;
		l = coalesce(array_length(rec_rat.item_ids, 1), 0)
			+ rec_rat.train_cnt + rec_rat.validate_cnt + rec_rat.test_cnt;
		i1 = ceil(1.0 * _train_pct / 100  * l) - rec_rat.train_cnt;
		i2 = (ceil(1.0 * (_train_pct + _validate_pct) / 100 * l) - i1) - rec_rat.validate_cnt;

		UPDATE malrec_ratings
		 SET dataset_type = (CASE 
		  WHEN item_id = ANY( rec_rat.item_ids[ 1 : i1 ] ) THEN 1
		  WHEN item_id = ANY( rec_rat.item_ids[ i1+1 : i1+i2 ] ) THEN 2
		  ELSE 3
		  END)
		 WHERE user_list_id = rec_rat.user_list_id AND dataset_type = 0;
	END LOOP;
	CLOSE cur_rats;

	RETURN 0;
END;
$$;


--
-- Name: malrec_unfix_for_train(boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION malrec_unfix_for_train(_use_all_for_train boolean) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
	-- apply changes to ratings that were made during train
	update malrec_ratings
	set rating = new_rating, new_rating = null
	where new_rating is not null;

	update malrec_ratings
	 set dataset_type = 0
	 where dataset_type = 4;

	if _use_all_for_train = false then
		-- unmark just trained U/I as used for train
		update malrec_items
		 set is_used_for_train = false
		 where is_used_for_train = true;
		
		update malrec_users
		 set is_used_for_train = false
		 where is_used_for_train = true;
	end if;
END;
$$;


--
-- Name: malrec_upd_stats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION malrec_upd_stats() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN

	update malrec_items it
	set ratings_count = sub.cnt, avg_rating = sub.avrg
	from (
	 select i.id, count(r.rating) as cnt, avg(r.rating) as avrg
	 from malrec_items as i
	 inner join malrec_ratings as r on r.item_id = i.id
	 where i.is_used_for_train = true 
		and r.dataset_type IN (1, 2) 
	 group by i.id
	) sub
	where sub.id = it.id;

	update malrec_users us
	set ratings_count = sub.cnt, avg_rating = sub.avrg
	from (
	 select u.list_id, count(r.rating) as cnt, avg(r.rating) as avrg
	 from malrec_users as u
	 inner join malrec_ratings as r on r.user_list_id = u.list_id
	 where u.is_used_for_train = true
		and r.dataset_type IN (1, 2) 
	 group by u.list_id
	) sub
	where sub.list_id = us.list_id;

END;
$$;


--
-- Name: malrec_update_user_most_rated_items(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION malrec_update_user_most_rated_items(_user_id integer, _max_rating integer) RETURNS void
    LANGUAGE plpgsql
    AS $$-- requires "CREATE EXTENSION intarray"

DECLARE _fav_items integer[];
DECLARE _most_rated_items integer[];
DECLARE _old_most_rated_items integer[];
DECLARE _new_most_rated_items integer[];
BEGIN

  select coalesce(ue.fav_items, array[]::int[]) as fav_items, array(
    select item_id
    from malrec_ratings
    where user_list_id = u.list_id and rating >= _max_rating * 0.9
  ), coalesce(ue.most_rated_items, array[]::int[])
  into _fav_items, _most_rated_items, _old_most_rated_items
  from malrec_users as u
  left join malrec_users_extra as ue
    on ue.id = u.id
  where u.id = _user_id;

  -- _new_most_rated_items := _fav_items | _most_rated_items;
  _new_most_rated_items := sort(_most_rated_items);

  -- tip: can simply compare with '=' because elements are sorted
  if _old_most_rated_items != _new_most_rated_items then
   update malrec_users_extra
    set most_rated_items = _new_most_rated_items
    where id = _user_id;
   update malrec_users
    set most_rated_items_update_ts = now()
    where id = _user_id;
  end if;

END;
$$;


SET default_tablespace = '';

SET default_with_oids = false;

--
-- Name: malrec_genres; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE malrec_genres (
    id integer NOT NULL,
    name character varying(100)
);


--
-- Name: malrec_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE malrec_items (
    id integer NOT NULL,
    name character(100),
    ratings_count integer DEFAULT 0,
    avg_rating double precision DEFAULT 0,
    genres integer[],
    franchise_id integer,
    type malrec_item_type,
    recs_update_ts timestamp without time zone,
    are_ratings_modified boolean DEFAULT true NOT NULL,
    is_used_for_train boolean DEFAULT false NOT NULL,
    recs_check_ts timestamp without time zone,
    is_deleted boolean DEFAULT false NOT NULL
);


--
-- Name: malrec_items_franchise_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE malrec_items_franchise_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: malrec_items_recs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE malrec_items_recs (
    from_id integer NOT NULL,
    to_id integer NOT NULL,
    weight integer DEFAULT 0 NOT NULL
);


--
-- Name: malrec_items_rels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE malrec_items_rels (
    from_id integer NOT NULL,
    to_id integer NOT NULL,
    rel malrec_items_rel
);


--
-- Name: malrec_ratings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE malrec_ratings (
    user_list_id integer NOT NULL,
    item_id integer NOT NULL,
    rating smallint NOT NULL,
    dataset_type smallint DEFAULT 0 NOT NULL,
    new_rating smallint
);


--
-- Name: malrec_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE malrec_users (
    id integer NOT NULL,
    login character(50),
    list_id integer,
    ratings_count integer DEFAULT 0,
    avg_rating double precision DEFAULT 0,
    list_update_ts timestamp without time zone,
    most_rated_items_update_ts timestamp without time zone,
    reg_date date,
    gender malrec_gender,
    are_ratings_modified boolean DEFAULT true NOT NULL,
    is_used_for_train boolean DEFAULT false NOT NULL,
    list_check_ts timestamp without time zone,
    need_to_check_list boolean DEFAULT false NOT NULL,
    is_deleted boolean DEFAULT false NOT NULL
)
WITH (fillfactor='50');


--
-- Name: malrec_users_extra; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE malrec_users_extra (
    id integer NOT NULL,
    unrated_items integer[],
    fav_items integer[],
    most_rated_items integer[]
);


--
-- Name: malrec_users_list_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE malrec_users_list_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: malrec_genres_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY malrec_genres
    ADD CONSTRAINT malrec_genres_id PRIMARY KEY (id);


--
-- Name: malrec_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY malrec_items
    ADD CONSTRAINT malrec_items_pkey PRIMARY KEY (id);


--
-- Name: malrec_items_recs_from_id_to_id_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY malrec_items_recs
    ADD CONSTRAINT malrec_items_recs_from_id_to_id_pkey PRIMARY KEY (from_id, to_id);


--
-- Name: malrec_items_rels_from_id_to_id_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY malrec_items_rels
    ADD CONSTRAINT malrec_items_rels_from_id_to_id_pkey PRIMARY KEY (from_id, to_id);


--
-- Name: malrec_ratings_item_id_user_list_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY malrec_ratings
    ADD CONSTRAINT malrec_ratings_item_id_user_list_id_key UNIQUE (item_id, user_list_id);


--
-- Name: malrec_ratings_user_list_id_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY malrec_ratings
    ADD CONSTRAINT malrec_ratings_user_list_id_item_id_key PRIMARY KEY (user_list_id, item_id);


--
-- Name: malrec_users_extra_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY malrec_users_extra
    ADD CONSTRAINT malrec_users_extra_pkey PRIMARY KEY (id);


--
-- Name: malrec_users_list_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY malrec_users
    ADD CONSTRAINT malrec_users_list_id_key UNIQUE (list_id);


--
-- Name: malrec_users_login_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY malrec_users
    ADD CONSTRAINT malrec_users_login_uniq UNIQUE (login);


--
-- Name: malrec_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY malrec_users
    ADD CONSTRAINT malrec_users_pkey PRIMARY KEY (id);


--
-- Name: malrec_items_are_ratings_modified_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX malrec_items_are_ratings_modified_idx ON malrec_items USING btree (are_ratings_modified);


--
-- Name: malrec_items_is_used_for_train_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX malrec_items_is_used_for_train_idx ON malrec_items USING btree (is_used_for_train);


--
-- Name: malrec_ratings_dataset_type_item_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX malrec_ratings_dataset_type_item_id_idx ON malrec_ratings USING btree (dataset_type, item_id);


--
-- Name: malrec_ratings_dataset_type_user_list_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX malrec_ratings_dataset_type_user_list_id_idx ON malrec_ratings USING btree (dataset_type, user_list_id);


--
-- Name: malrec_users_are_ratings_modified_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX malrec_users_are_ratings_modified_idx ON malrec_users USING btree (are_ratings_modified);


--
-- Name: malrec_users_is_used_for_train_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX malrec_users_is_used_for_train_idx ON malrec_users USING btree (is_used_for_train);


--
-- Name: malrec_ratings_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY malrec_ratings
    ADD CONSTRAINT malrec_ratings_item_id_fkey FOREIGN KEY (item_id) REFERENCES malrec_items(id);


--
-- Name: malrec_ratings_user_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY malrec_ratings
    ADD CONSTRAINT malrec_ratings_user_list_id_fkey FOREIGN KEY (user_list_id) REFERENCES malrec_users(list_id);


--
-- Name: malrec_users_extra_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY malrec_users_extra
    ADD CONSTRAINT malrec_users_extra_id_fkey FOREIGN KEY (id) REFERENCES malrec_users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

