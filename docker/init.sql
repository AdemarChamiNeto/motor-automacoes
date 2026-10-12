-- Simula o Neon: o dono do banco NÃO é superusuário (só pode criar papéis).
-- Senha só de desenvolvimento local; em produção o DATABASE_URL vem da hospedagem.
CREATE ROLE motor LOGIN CREATEROLE PASSWORD 'motor-dev';
CREATE DATABASE motor OWNER motor;
CREATE DATABASE motor_test OWNER motor;
