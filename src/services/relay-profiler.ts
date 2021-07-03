import {
  BaseProfiler,
  ProfileResult,
} from '@pokt-network/pocket-js';

import {Pool as PGPool} from 'pg';

const pgFormat = require('pg-format');
const logger = require('../services/logger');