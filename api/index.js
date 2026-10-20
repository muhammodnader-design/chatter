const { handleApi } = require('../lib/httpApi');

module.exports = async (req, res) => {
  await handleApi(req, res);
};
