'use strict';

const Joi = require('joi');

const loginSchema = Joi.object({
  username: Joi.string().trim().min(1).max(100).required(),
  password: Joi.string().min(1).max(200).required(),
}).options({ abortEarly: false, stripUnknown: false, presence: 'required' });

module.exports = { loginSchema };
