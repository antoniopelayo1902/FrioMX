const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const sns = new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' });

// Publica un aviso para un jugador. La suscripción filtra por audience = userId (LLD §7).
// Sin USER_TOPIC_ARN no publica y regresa false.
async function publishToUser(userId, message, subject = 'FrioMx') {
    const topicArn = process.env.USER_TOPIC_ARN;
    if (!topicArn) return false;
    await sns.send(new PublishCommand({
        TopicArn: topicArn,
        Subject: subject,
        Message: message,
        MessageAttributes: { audience: { DataType: 'String', StringValue: String(userId) } },
    }));
    return true;
}

module.exports = { sns, publishToUser };
